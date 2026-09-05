// Verifies against a real pi process that inherited AGENTS.md files are absent
// from the provider request while explicitly approved context is present.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExplicitContextBundle } from "../src/runner/context-files.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { resolveModel, staticCatalog } from "../src/runner/model-resolver.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";

const MODEL = await resolveModel(staticCatalog([{ provider: "mock", id: "mock-1" }]), "mock", "mock-1");

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_BIN = defaultPiBinary();
const MOCK_PORT = process.env.HIVEMIND_MOCK_PORT ?? "8133";
const POISON = "CONTEXT_POISON_MUST_NOT_REACH_PROVIDER";
const ALLOWED = "EXPLICIT_CONTEXT_REACHED_PROVIDER";

function startMock(logPath: string): ChildProcess {
  return spawn(
    process.execPath,
    [join(REPO, "poc", "rpc-context", "mock-provider-server.mjs"), "--port", MOCK_PORT],
    {
      env: { ...process.env, MOCK_LOG_REQUESTS: logPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitForMock(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`)).ok) return;
    } catch {
      // The mock has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("mock provider never became reachable");
}

async function run(
  cwd: string,
  sessionDir: string,
  contextFiles: "explicit" | "inherit",
  systemText?: string,
): Promise<void> {
  const runner = new RpcPiRunner({
    binary: PI_BIN,
    provider: "mock",
    model: MODEL,
    cwd,
    tools: [],
    extensions: [join(REPO, "poc", "rpc-context", "mock-provider-extension.mjs")],
    sessionDir,
    contextFiles,
    env: { HIVEMIND_MOCK_PORT: MOCK_PORT },
    ...(systemText ? { systemPrompt: { mode: "append" as const, text: systemText } } : {}),
  });
  try {
    await runner.start();
    await runner.setAutoRetry(false);
    await runner.prompt("Reply with ping.", 45_000);
  } finally {
    await runner.stop();
  }
}

async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "hivemind-context-isolation-"));
  const contaminatedRoot = join(work, "contaminated");
  const cwd = join(contaminatedRoot, "child");
  const allowedPath = join(work, "allowed.md");
  const requestLog = join(work, "requests.jsonl");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(contaminatedRoot, "AGENTS.md"), `${POISON}\n`, "utf8");
  await writeFile(allowedPath, `${ALLOWED}\n`, "utf8");
  const bundle = await loadExplicitContextBundle([{ label: "approved-test-context", path: allowedPath }]);

  const mock = startMock(requestLog);
  try {
    await waitForMock();
    await run(cwd, join(work, "inherit-sessions"), "inherit");
    await run(cwd, join(work, "explicit-sessions"), "explicit", bundle.text);

    const requests = (await readFile(requestLog, "utf8")).trim().split("\n");
    if (requests.length !== 2) throw new Error(`expected 2 provider requests, got ${requests.length}`);
    const inherited = requests[0] ?? "";
    const explicit = requests[1] ?? "";
    const hazardConfirmed = inherited.includes(POISON);
    const poisonBlocked = !explicit.includes(POISON);
    const approvedLoaded = explicit.includes(ALLOWED);
    console.log(`inherit contains ancestor AGENTS.md: ${hazardConfirmed}`);
    console.log(`explicit excludes ancestor AGENTS.md: ${poisonBlocked}`);
    console.log(`explicit includes approved context: ${approvedLoaded}`);
    console.log(`effective context sha256: ${bundle.files[0]?.sha256}`);
    if (!hazardConfirmed || !poisonBlocked || !approvedLoaded) throw new Error("context isolation contract failed");
    console.log("PASS: provider request contains only explicitly approved context");
  } finally {
    mock.kill("SIGKILL");
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("FAILED:", error);
  process.exit(1);
});
