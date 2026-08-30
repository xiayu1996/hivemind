import { createClient } from "@libsql/client";
import { deepStrictEqual } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname, homedir, platform, release } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createConsoleServer, listenConsole } from "../src/console/server.js";
import { LibsqlConsoleDataSource } from "../src/console/libsql-data-source.js";
import { CanonicalLogWriter, readCanonicalLog, rebuildModelRequest, validateCoordinates } from "../src/observability/canonical-log.js";
import { CostLedger } from "../src/observability/cost-ledger.js";
import { migrate } from "../src/persistence/migrate.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_BIN = process.env.PI_BIN ?? join(
  homedir(), ".hivemind", "pi", "0.84.3", "pi", process.platform === "win32" ? "pi.exe" : "pi",
);
const MOCK_PORT = process.env.HIVEMIND_MOCK_PORT ?? "19099";
const CONSOLE_PORT = Number(process.env.HIVEMIND_CONSOLE_PORT ?? "3211");

function startMock(requestLog: string): ChildProcess {
  return spawn(process.execPath, [join(REPO, "poc", "rpc-context", "mock-provider-server.mjs"), "--port", MOCK_PORT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOCK_LOG_REQUESTS: requestLog },
  });
}

async function waitForMock(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`)).ok) return;
    } catch {
      // The local server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("mock provider never became reachable");
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      if (typeof part !== "object" || part === null) return false;
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string";
    })
    .map((part) => part.text)
    .join("");
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "hm-observability-"));
  const requestLog = join(scratch, "provider-requests.jsonl");
  const canonicalPath = join(scratch, "run-events.jsonl");
  const databasePath = join(scratch, "console.db");
  const mock = startMock(requestLog);
  let app: Awaited<ReturnType<typeof createConsoleServer>> | undefined;
  try {
    await waitForMock();
    const runner = new RpcPiRunner({
      binary: PI_BIN,
      provider: "mock",
      model: "mock-1",
      cwd: REPO,
      tools: [],
      contextFiles: "explicit",
      extensions: [join(REPO, "poc", "rpc-context", "mock-provider-extension.mjs")],
      systemPrompt: { mode: "replace", text: "You are the observability smoke agent." },
      env: { HIVEMIND_MOCK_PORT: MOCK_PORT },
    });
    await runner.start();
    await runner.setAutoRetry(false);
    const result = await runner.prompt("Return a short health acknowledgement.");
    await runner.stop();
    mock.kill("SIGKILL");

    const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const actual = requests.at(-1)!;
    const messages = actual.messages as Array<Record<string, unknown>>;
    const systemPrompt = messages.filter((message) => message.role === "system").map((message) => textContent(message.content)).join("\n");
    const visibleMessages = messages.filter((message) => message.role !== "system");
    const tools = Array.isArray(actual.tools) ? actual.tools : [];

    const writer = new CanonicalLogWriter(canonicalPath, 0, (() => { let time = Date.now(); return () => time++; })());
    await writer.append("request/header", { systemPrompt, tools });
    await writer.append("request/context", { provider: "mock", model: String(actual.model), contextWindow: 128_000 });
    await writer.append("request/messages", { messages: visibleMessages });
    await writer.append("turn_start", { turn: 1 });
    await writer.append("step_start", { turn: 1, step: 1 });
    await writer.append("assistant/chunk", { turn: 1, step: 1, text: "ACK" });
    await writer.append("assistant_message", { turn: 1, step: 1 });
    await writer.append("step_end", { turn: 1, step: 1 });
    await writer.append("turn_end", { turn: 1, reason: "completed" });
    await writer.append("shutdown", { clean: true });
    const canonical = await readCanonicalLog(canonicalPath);
    validateCoordinates(canonical);
    deepStrictEqual(rebuildModelRequest(canonical), {
      header: { systemPrompt, tools },
      context: { provider: "mock", model: String(actual.model), contextWindow: 128_000 },
      messages: visibleMessages,
    });

    const client = createClient({ url: `file:${databasePath}` });
    await migrate(client);
    const now = Date.now();
    await client.execute({
      sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, phase, branch, created_at, updated_at)
            VALUES ('m1-windows', 'local-smoke', 'M1 Windows observability smoke',
                    'Verify observability data', 'VERIFY', 'VERIFY', 'main', ?, ?)`,
      args: [now, now],
    });
    for (const event of canonical) {
      await client.execute({
        sql: "INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data) VALUES ('run-console-smoke', ?, 'm1-windows', 'VERIFY', ?, ?, ?)",
        args: [event.seq, event.type, event.time, JSON.stringify(event.data)],
      });
    }
    await new CostLedger(client).record({
      runId: "run-console-smoke",
      cardId: "m1-windows",
      phase: "VERIFY",
      purpose: "smoke",
      tier: "small",
      provider: "mock",
      modelId: "mock-1",
      hostId: hostname(),
    }, result.usage);
    await client.execute({
      sql: "INSERT INTO config_entries (key, value_json, updated_by, updated_at) VALUES ('console.bindHost', ?, 'smoke', ?)",
      args: [JSON.stringify("127.0.0.1"), now],
    });

    const source = new LibsqlConsoleDataSource(client, async () => [{
      hostId: hostname(),
      status: "healthy",
      os: platform(),
      osRelease: release(),
      node: process.version,
      pi: "0.84.3",
    }]);
    app = await createConsoleServer(source, { uiRoot: join(REPO, "console-ui", "dist") });
    const address = await listenConsole(app, { host: "127.0.0.1", port: CONSOLE_PORT });
    console.log(`PASS: canonical request rebuild is byte-equivalent after JSON normalisation (${canonical.length} events)`);
    console.log(`PASS: cost ledger equals pi self-report (${result.usage.costUsd})`);
    console.log(`Console ready at ${address}`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    client.close();
  } finally {
    mock.kill("SIGKILL");
    await app?.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("FAILED:", error);
  process.exit(1);
});
