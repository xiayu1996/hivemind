import { createClient, type Client } from "@libsql/client";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";

const TSX = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const ENTRY = fileURLToPath(new URL("../../scripts/serve-console.ts", import.meta.url));

let client: Client;
let child: ChildProcess;
let directory: string;
let html: string;
let output = "";

function section(document: string, startMarker: string, endMarker: string): string {
  const start = document.indexOf(startMarker);
  const end = document.indexOf(endMarker, start + 1);
  return document.slice(start, end < 0 ? undefined : end);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not reserve a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function readWhenReady(url: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`console exited before becoming ready: ${output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response.text();
    } catch {
      // The child has not bound its port yet; retry until the startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`console did not become ready: ${output}`);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "overview-review-regression-"));
  const databasePath = join(directory, "central.db");
  client = createClient({ url: `file:${databasePath}` });
  await migrate(client);
  await client.batch([
    {
      sql: `INSERT INTO requirements
              (id, notion_page_id, title, state, original_request, created_at, updated_at)
            VALUES ('R-OTHER-1', 'page-R-OTHER-1', ?, 'SOLUTION', 'request', 1, 600)`,
      args: ["\u522b\u7684\u8fd0\u884c\u9700\u6c42"],
    },
    {
      sql: `INSERT INTO stories
              (id, notion_page_id, title, requirement, state, phase, created_at, updated_at)
            VALUES ('S-OTHER-1', 'page-S-OTHER-1', ?, 'request', 'CODE', 'CODE', 2, 500)`,
      args: ["\u522b\u7684\u8fd0\u884c\u4efb\u52a1"],
    },
    {
      sql: `INSERT INTO stories
              (id, notion_page_id, title, requirement, state, phase, created_at, updated_at)
            VALUES ('S-RECOVERED', 'page-S-RECOVERED', ?, 'request', 'CODE', 'CODE', 3, 400)`,
      args: ["\u5df2\u7ecf\u6062\u590d\u7684\u65e7\u5931\u8d25"],
    },
    {
      sql: `INSERT INTO phase_runs
              (run_id, card_id, phase, round, prompt_sha256, status, failure, started_at, ended_at)
            VALUES ('old-failure', 'S-RECOVERED', 'VERIFY', 1, ?, 'failed', ?, 100, 200)`,
      args: ["a".repeat(64), "\u65e7\u5931\u8d25\u539f\u56e0"],
    },
  ], "write");
  client.close();

  const port = await unusedPort();
  child = spawn(process.execPath, [TSX, ENTRY, "--port", String(port)], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      HIVEMIND_DB_URL: `file:${databasePath}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  html = await readWhenReady(`http://127.0.0.1:${port}/`);
}, 20_000);

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
  }
  if (client) client.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("overview data opened by a verification round", () => {
  it("@scenario S-R237511OV-01-active presents the declared requirement and two tasks in newest-first order", () => {
    const active = section(html, 'id="active-title"', 'id="failures-title"');

    expect(active).toContain("\u8fd0\u884c\u4e2d <span class=\"heading-count\">3 \u9879");
    expect(active).toContain('aria-label="\u91cd\u8bd5\u9000\u907f \u4efb\u52a1 CODE \u8fd0\u884c\u4e2d"');
    expect(active).toContain('aria-label="\u91cd\u8bd5\u7b56\u7565\u6536\u655b \u9700\u6c42 SOLUTION \u8fd0\u884c\u4e2d"');
    expect(active).toContain('aria-label="\u5f02\u5e38\u5f52\u7c7b \u4efb\u52a1 VERIFY \u8fd0\u884c\u4e2d"');
    expect(active.indexOf("\u91cd\u8bd5\u9000\u907f")).toBeLessThan(active.indexOf("\u91cd\u8bd5\u7b56\u7565\u6536\u655b"));
    expect(active.indexOf("\u91cd\u8bd5\u7b56\u7565\u6536\u655b")).toBeLessThan(active.indexOf("\u5f02\u5e38\u5f52\u7c7b"));
  });

  it("@scenario S-R237511OV-01-active does not substitute unrelated central-store work for the declared running items", () => {
    const active = section(html, 'id="active-title"', 'id="failures-title"');

    expect(active).not.toContain("\u522b\u7684\u8fd0\u884c\u9700\u6c42");
    expect(active).not.toContain("\u522b\u7684\u8fd0\u884c\u4efb\u52a1");
    expect(active).not.toContain("\u5df2\u7ecf\u6062\u590d\u7684\u65e7\u5931\u8d25");
  });

  it("@scenario S-R237511OV-01-failures presents both current failures with stage, reason and newest-first time", () => {
    const failures = section(html, 'id="failures-title"', 'id="completed-title"');

    expect(failures).toContain("\u5931\u8d25 <span class=\"heading-count\">2 \u9879");
    expect(failures).toContain('aria-label="\u8d26\u5355\u5bfc\u51fa \u4efb\u52a1 VERIFY \u5931\u8d25 \u9a8c\u6536\u672a\u901a\u8fc7 ');
    expect(failures).toContain('aria-label="\u8d26\u5355\u5bfc\u51fa\u89c4\u5219 \u9700\u6c42 SOLUTION \u5931\u8d25 \u65b9\u6848\u65e0\u6cd5\u5f62\u6210 ');
    expect(failures.indexOf("\u8d26\u5355\u5bfc\u51fa")).toBeLessThan(failures.indexOf("\u8d26\u5355\u5bfc\u51fa\u89c4\u5219"));
  });

  it("@scenario S-R237511OV-01-failures omits a recovered historical failure from the current failure section", () => {
    const failures = section(html, 'id="failures-title"', 'id="completed-title"');

    expect(failures).not.toContain("\u5df2\u7ecf\u6062\u590d\u7684\u65e7\u5931\u8d25");
    expect(failures).not.toContain("\u65e7\u5931\u8d25\u539f\u56e0");
  });
});
