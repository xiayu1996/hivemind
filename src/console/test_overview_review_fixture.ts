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
let port: number;
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

async function get(path: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return response.text();
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

  port = await unusedPort();
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

describe("the overview a verification round opens", () => {
  it("@scenario S-R237511OV-01-todo every open item appears once with its type, requirement, wait and action", () => {
    const todos = section(html, 'id="todos-title"', 'id="active-title"');
    expect(todos).toContain("等待本人处理 <span class=\"heading-count\">3 项");
    expect(todos).toContain("需要答复");
    expect(todos).toContain("需要选择");
    expect(todos).toContain("需要批准");
    expect(todos).toContain("支付重试规则");
    expect(todos).toContain("费用统计时区");
    expect(todos).toContain("后台首屏");
    expect(todos).toContain("已等待");
    expect(todos).toContain("/todo?requirement=R-PAY");
    expect(todos).toContain("/todo?requirement=R-TZ");
    expect(todos).toContain("/todo?requirement=R-PRD");
  });
  it("@scenario S-R237511OV-01-active presents the declared requirement and two tasks in newest-first order", () => {
    const active = section(html, 'id="active-title"', 'id="failures-title"');
    expect(active).toContain("运行中 <span class=\"heading-count\">3 项");
    expect(active).toContain('aria-label="重试退避 任务 CODE 运行中"');
    expect(active).toContain('aria-label="重试策略收敛 需求 SOLUTION 运行中"');
    expect(active).toContain('aria-label="异常归类 任务 VERIFY 运行中"');
    expect(active.indexOf("重试退避")).toBeLessThan(active.indexOf("重试策略收敛"));
    expect(active.indexOf("重试策略收敛")).toBeLessThan(active.indexOf("异常归类"));
  });
  it("@scenario S-R237511OV-01-failures presents both current failures with stage, reason and newest-first time", () => {
    const failures = section(html, 'id="failures-title"', 'id="completed-title"');
    expect(failures).toContain("失败 <span class=\"heading-count\">2 项");
    expect(failures).toContain('aria-label="账单导出 任务 VERIFY 失败 验收未通过 ');
    expect(failures).toContain('aria-label="账单导出规则 需求 SOLUTION 失败 方案无法形成 ');
    expect(failures).toContain("验收未通过");
    expect(failures).toContain("方案无法形成");
    expect(failures.indexOf("账单导出")).toBeLessThan(failures.indexOf("账单导出规则"));
  });
  it("@scenario S-R237511OV-01-recent7d includes both sides of the seven-day boundary and drops everything outside it", () => {
    const completed = section(html, 'id="completed-title"', '<aside class="stack"');
    expect(completed).toContain("最近完成 <span class=\"heading-count\">2 项");
    expect(completed).toContain("状态投影核对");
    expect(completed).toContain("候选词表更新");
    expect(completed).toContain("已完成");
    expect(completed.indexOf("状态投影核对")).toBeLessThan(completed.indexOf("候选词表更新"));
  });
  it("@scenario S-R237511OV-01-refresh re-reads the same block while the page stays open", async () => {
    const active = section(html, 'id="active-title"', 'id="failures-title"');
    expect(html).toContain("/assets/overview.js");
    expect(html).toContain('id="refreshed-at"');
    expect(html).toContain("每 30 秒自动刷新");
    expect(active).toContain('aria-label="重试退避 任务 CODE 运行中"');
    const refreshed = JSON.parse(await get("/overview/sections")) as { body: string; refreshed: string; revision: string };
    expect(refreshed.body).toContain('aria-label="重试退避 任务 CODE 运行中"');
    expect(refreshed.refreshed).toContain("最近刷新");
    expect(refreshed.revision.length).toBeGreaterThan(0);
  });
  it("@scenario S-R237511OV-01-responsive keeps the fixed section order and both navigations on one page", () => {
    expect(html.indexOf('id="todos-title"')).toBeLessThan(html.indexOf('id="active-title"'));
    expect(html.indexOf('id="active-title"')).toBeLessThan(html.indexOf('id="failures-title"'));
    expect(html.indexOf('id="failures-title"')).toBeLessThan(html.indexOf('id="completed-title"'));
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="mobile-nav"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("重试退避");
    expect(html).toContain("支付重试规则");
    expect(html).toContain("账单导出");
    expect(html).toContain("状态投影核对");
  });
  it("@scenario S-R237511OV-01-states says what each reading state waits for instead of a blank page", async () => {
    expect(await get("/?state=loading")).toContain("正在读取运行情况");
    expect(await get("/?state=empty")).toContain("当前没有运行事项");
    expect(await get("/?state=error")).toContain("无法读取运行总览");
    expect(await get("/?state=waiting")).toContain("运行结果尚未产生");
    expect(html).toContain("重试退避");
  });
  it("@scenario S-R237511OV-01-costs states the amount, its range and an overrun that keeps working", () => {
    const summary = section(html, '<aside class="stack"', "</aside>");
    expect(summary).toContain("USD $20.00");
    expect(summary).toContain("统计范围");
    expect(summary).toContain("Asia/Shanghai");
    expect(summary).toContain("已花 USD $20.00 / 上限 USD $15.00");
    expect(summary).toContain("已超限");
    expect(summary).toContain("工作仍继续");
  });
  it("@scenario S-R237511OV-01-todo a handled item never appears in the waiting rail", () => {
    const todos = section(html, 'id="todos-title"', 'id="active-title"');
    expect(todos).not.toContain("已经处理的需求");
    expect(todos).not.toContain("R-HANDLED");
  });
});
