import { describe, expect, it } from "vitest";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import { createSampleWorkRecordReader } from "./work-record-sample.js";
import { loadWorkRecordScreen } from "./work-records.js";
import { WorkRecordReadError, type WorkRecordReader } from "../observability/work-record-reader.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({}),
  providers: async () => [],
  queue: async () => ({}),
};

async function records(url: string): Promise<string> {
  const app = await createConsoleServer(data, {
    serveUi: false,
    workRecords: createSampleWorkRecordReader(Date.now()),
  });
  try {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    return response.body;
  } finally {
    await app.close();
  }
}

describe("work records route", () => {
  it("@scenario S-R237511TR-01-search serves the matching runs with role, name, requirement and the literal hit", async () => {
    const body = await records("/records?keyword=Notion%20%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5");
    expect(body).toContain("工作记录排查");
    expect(body).toContain("搜索工作记录");
    expect(body).toContain("搜索记录");
    expect(body).toContain("匹配记录");
    expect(body).toContain("找到 2 条完整记录");
    expect(body).toContain("prototype · 原型出口修正");
    expect(body).toContain("engineer · 同步任务");
    expect(body).toContain("Hivemind 的 web 管理后台");
    expect(body).toContain("命中：");
    expect(body).toContain('命中：待办处理结果在 <mark class="hit">Notion 保存失败</mark> 后保持未处理');
    expect(body).not.toContain("每日费用汇总完成");
    expect(body).not.toContain("周期性优化");
  });

  it("@scenario S-R237511TR-01-full serves the selected work from start to stop with the error line marked", async () => {
    const body = await records("/records?runId=run-prototype-exit");
    expect(body).toContain("prototype · 原型出口修正");
    expect(body).toContain("出现错误");
    expect(body).toContain("查看关联需求");
    expect(body).toContain("问题前后的行为");
    expect(body).toContain("开始 10:38:12 · 结束 10:43:06 · 共 4分54秒");
    expect(body).toContain('class="step error"');
    const record = body.slice(body.indexOf('id="record"'));
    expect(record.indexOf("形成操作型界面的设计计划")).toBeLessThan(record.indexOf("连接在确认前断开"));
    expect(record.indexOf("连接在确认前断开")).toBeLessThan(record.indexOf("保持未处理"));
    expect(body).not.toContain("每日费用汇总完成");
    expect(body).not.toContain("sk-live4f9c2b7a1d90");
    expect(body).toContain("[REDACTED]");
  });

  it("@scenario S-R237511TR-01-empty serves the adjustment advice and drops the earlier result and record", async () => {
    const body = await records("/records?keyword=%E8%B4%B9%E7%94%A8%E8%B6%85%E9%99%90%E5%90%8E%E5%81%9C%E6%AD%A2&role=&range=24h");
    expect(body).toContain("没有匹配的工作记录");
    expect(body).toContain("修改搜索条件");
    expect(body).not.toContain("原型出口修正");
    expect(body).not.toContain("读取已批准的页面清单与场景");
  });

  it("@scenario S-R237511TR-01-loading serves what is being searched and no previous result", async () => {
    const body = await records("/records?keyword=Notion%20%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&role=prototype&range=24h&state=loading");
    expect(body).toContain('<div class="state-card" role="status"><h2>正在搜索完整工作记录</h2>');
    expect(body).toContain("正在查找最近 24 小时内包含“Notion 保存失败”的记录，请稍候。");
    expect(body).not.toContain("周期性优化");
  });

  it("@scenario S-R237511TR-01-error renders the failed search when the reader itself fails", async () => {
    const failing: WorkRecordReader = {
      search: async () => { throw new WorkRecordReadError("unavailable", true, "the store did not answer"); },
      read: async () => { throw new WorkRecordReadError("not_found", false, "no work record"); },
    };
    const app = await createConsoleServer(data, { serveUi: false, workRecords: failing });
    try {
      const response = await app.inject({ method: "GET", url: "/records?keyword=Notion%20%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&role=prototype&range=24h" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<h2>无法搜索工作记录</h2>");
      expect(response.body).toContain("<button type=\"submit\">重新搜索</button>");
      expect(response.body).toContain('value="Notion 保存失败"');
      expect(response.body).toContain('value="prototype" selected');
      expect(response.body).toContain('value="24h" selected');
      expect(response.body).not.toContain("同步任务");
    } finally {
      await app.close();
    }
  });

  it("@scenario S-R237511TR-01-error keeps the three conditions, offers a retry and hides the old result", async () => {
    const body = await records("/records?keyword=Notion%20%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&role=prototype&range=24h&state=error");
    expect(body).toContain("<h2>无法搜索工作记录</h2>");
    expect(body).toContain("<button type=\"submit\">重新搜索</button>");
    expect(body).toContain('value="Notion 保存失败"');
    expect(body).toContain('value="prototype" selected');
    expect(body).toContain('value="24h" selected');
    expect(body).not.toContain("同步任务");
  });

  it("@scenario S-R237511TR-01-error serves every state's own URL with the criteria on the page", async () => {
    const body = await records("/records?keyword=Notion%20%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&role=prototype&range=24h");
    expect(body).toContain("页面状态");
    expect(body).toContain('href="/records?keyword=Notion+%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&role=prototype&range=24h&state=error"');
    expect(body).toContain('href="/records?keyword=Notion+%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&role=prototype&range=24h&state=loading"');
    const failed = await records("/records?keyword=Notion%20%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&role=prototype&range=24h&state=error");
    expect(failed).toContain("<h2>无法搜索工作记录</h2>");
    expect(failed).toContain("<button type=\"submit\">重新搜索</button>");
    expect(failed).not.toContain("同步任务");
  });

  it("@scenario S-R237511TR-01-waiting serves the still-running work with its existing steps", async () => {
    const body = await records("/records?keyword=Notion%20%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&role=engineer&range=24h&state=waiting");
    expect(body).toContain("正在等待最新记录写入");
    expect(body).toContain("页面会自动刷新，已有片段不会丢失");
    expect(body).toContain("等待下一步结果");
    // The waiting record itself never says the work finished. The refresh
    // script names the finished result it will write when it arrives, and a
    // script is not part of the screen the assertion is about.
    expect(body.slice(0, body.indexOf("<script>"))).not.toContain("已完成");
  });

  it("@scenario S-R237511TR-01-mobile serves a single column with the current navigation item named", async () => {
    const body = await records("/records");
    expect(body).toContain('aria-label="手机导航"');
    expect(body).toContain('aria-current="page" href="/records">记录</a>');
    expect(body).toContain("@media (max-width:760px)");
    expect(body).toContain(".record-split{grid-template-columns:1fr}");
  });

  it("serves the read-only work-record API and refuses an unknown run", async () => {
    const app = await createConsoleServer(data, {
      serveUi: false,
      workRecords: createSampleWorkRecordReader(Date.now()),
    });
    try {
      const search = await app.inject({
        method: "GET",
        url: `/api/work-records?keyword=Notion%20%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&from=${Date.now() - 86_400_000}&to=${Date.now()}`,
      });
      expect(search.statusCode).toBe(200);
      expect(search.json().matches.map((match: { runId: string }) => match.runId).toSorted()).toEqual([
        "run-prototype-exit",
        "run-todo-sync",
      ]);
      const detail = await app.inject({ method: "GET", url: "/api/work-records/run-todo-sync" });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().record.runId).toBe("run-todo-sync");
      const missing = await app.inject({ method: "GET", url: "/api/work-records/run-missing" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("@scenario S-R237511TR-02-live 样例源在注视下写完收尾步骤并把这次工作结束掉", async () => {
    let clock = NOW;
    const reader = createSampleWorkRecordReader(() => clock);

    const opened = await reader.read({ runId: "run-engineer-optimization" });
    expect(opened.record.status).toEqual({ kind: "running", refreshAfterMs: 5_000 });
    expect(opened.record.steps.map((step) => step.text.value)).toEqual(["读取当前任务", "检查控制台可用性"]);
    expect(opened.record.throughSequence).toBe(2);

    clock = NOW + 8_000;
    const continued = await reader.read({ runId: "run-engineer-optimization", afterSequence: 2 });
    expect(continued.incremental).toBe(true);
    expect(continued.record.steps.map((step) => step.text.value)).toEqual(["本轮优化完成"]);
    expect(continued.record.status).toEqual({
      kind: "stopped",
      outcome: "completed",
      stoppedAt: Date.parse("2026-09-20T10:07:30.000Z"),
      durationMs: 138_000,
    });
    expect(continued.record.throughSequence).toBe(3);
  });

  it("keeps every sample match inside the last 24 hours whatever hour it is read at", async () => {
    const reader = createSampleWorkRecordReader(NOW);
    const result = await reader.search({ keyword: "Notion 保存失败", fromInclusive: NOW - 86_400_000, toExclusive: NOW });
    expect(result.matches.map((match) => match.runId).toSorted()).toEqual([
      "run-prototype-exit",
      "run-todo-sync",
    ]);
    // Newest occurrence first, whatever the run times work out to.
    const times = result.matches.map((match) => match.occurredAt);
    expect(times).toEqual([...times].toSorted((left, right) => right - left));
    expect(await loadWorkRecordScreen(reader, { keyword: "", range: "24h" }, NOW)).toMatchObject({ kind: "ready" });
  });
});
