import { describe, expect, it } from "vitest";
import {
  formatWorkRecordDuration,
  reduceWorkRecordScreen,
  renderWorkRecordsPage,
  workRecordRangeLabel,
  type WorkRecordSearchRequest,
  type WorkRecordSearchState,
  type WorkRecordSelectionState,
} from "./work-records.js";
import type {
  WorkRecordDetail,
  WorkRecordMatch,
  WorkRecordSearchQuery,
} from "../observability/work-record-reader.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const FAILURE = "Notion 保存失败";

function request(requestId: string, criteria: WorkRecordSearchQuery): WorkRecordSearchRequest {
  return { requestId, query: criteria };
}

function query(overrides: Partial<WorkRecordSearchQuery> = {}): WorkRecordSearchQuery {
  return { keyword: FAILURE, fromInclusive: NOW - DAY, toExclusive: NOW, ...overrides };
}

function match(overrides: Partial<WorkRecordMatch> = {}): WorkRecordMatch {
  return {
    runId: "run-prototype",
    role: "prototype",
    name: "原型出口修正",
    occurredAt: NOW - 60_000,
    status: { kind: "running" },
    requirement: { id: "R-101", title: "Hivemind 的 web 管理后台" },
    hit: [{ value: `${FAILURE} 后保持未处理`, matched: true, redaction: "applied" }],
    ...overrides,
  };
}

function readyState(
  stateQuery: WorkRecordSearchQuery,
  matches: readonly WorkRecordMatch[],
  selection: WorkRecordSelectionState = { kind: "none" },
): WorkRecordSearchState {
  return { kind: "ready", request: request("r1", stateQuery), result: { query: stateQuery, matches, snapshotAt: NOW }, selection };
}

function stoppedErrorRecord(): WorkRecordDetail {
  const startedAt = Date.parse("2026-09-20T10:38:12.000Z");
  const stoppedAt = Date.parse("2026-09-20T10:43:06.000Z");
  return {
    runId: "run-selected",
    role: "prototype",
    name: "原型出口修正",
    requirement: { id: "R-101", title: "Hivemind 的 web 管理后台" },
    startedAt,
    status: { kind: "stopped", outcome: "error", stoppedAt, durationMs: stoppedAt - startedAt },
    steps: [
      { runId: "run-selected", sequence: 1, occurredAt: startedAt, kind: "start", text: { value: "读取已批准的页面清单与场景", redaction: "applied" } },
      { runId: "run-selected", sequence: 2, occurredAt: startedAt + 120_000, kind: "action", text: { value: "形成操作型界面的设计计划", redaction: "applied" } },
      { runId: "run-selected", sequence: 3, occurredAt: startedAt + 231_000, kind: "error", text: { value: `${FAILURE}：连接在确认前断开`, redaction: "applied" } },
      { runId: "run-selected", sequence: 4, occurredAt: startedAt + 231_000, kind: "action", text: { value: "保持待办为“待批准”，未提前显示已处理", redaction: "applied" } },
      { runId: "run-selected", sequence: 5, occurredAt: stoppedAt, kind: "stop", text: { value: "本轮停止，等待本人检查连接后重试", redaction: "applied" } },
    ],
    throughSequence: 5,
  };
}

function runningRecord(): WorkRecordDetail {
  const startedAt = NOW - 60_000;
  return {
    runId: "run-working",
    role: "engineer",
    name: "同步任务",
    requirement: { id: "R-202", title: "Notion 同步修复" },
    startedAt,
    status: { kind: "running", refreshAfterMs: 5_000 },
    steps: [
      { runId: "run-working", sequence: 1, occurredAt: startedAt, kind: "start", text: { value: "Work started", redaction: "applied" } },
      { runId: "run-working", sequence: 2, occurredAt: startedAt + 10_000, kind: "action", text: { value: "Opened the todo", redaction: "applied" } },
      { runId: "run-working", sequence: 3, occurredAt: startedAt + 20_000, kind: "action", text: { value: `检测到 ${FAILURE}，准备重试`, redaction: "applied" } },
    ],
    throughSequence: 3,
  };
}

describe("work records page", () => {
  it("@scenario S-R237511TR-01-search 结果列表给出角色、工作名称、发生时间、所属需求与命中原句", () => {
    const html = renderWorkRecordsPage(readyState(query(), [
      match({ runId: "run-engineer", role: "engineer", name: "同步任务", occurredAt: NOW - 30_000, requirement: { id: "R-202", title: "Notion 同步修复" }, hit: [
        { value: "检测到 ", matched: false, redaction: "applied" },
        { value: FAILURE, matched: true, redaction: "applied" },
        { value: "，准备重试", matched: false, redaction: "applied" },
      ] }),
      match(),
    ]));

    expect(html).toContain("工作记录排查");
    expect(html).toContain("搜索工作记录");
    expect(html).toContain("搜索记录");
    expect(html).toContain("匹配记录");
    expect(html).toContain("engineer · 同步任务");
    expect(html).toContain("prototype · 原型出口修正");
    expect(html).toContain("Notion 同步修复");
    expect(html).toContain("命中：检测到 <mark class=\"hit\">Notion 保存失败</mark>，准备重试");
    expect(html).toContain("找到 2 条完整记录");
  });

  it("@scenario S-R237511TR-01-full 选中记录后按时间顺序显示错误位置与其前后行为", () => {
    const html = renderWorkRecordsPage(readyState(query(), [match()], {
      kind: "ready",
      runId: "run-selected",
      requestId: "s1",
      record: stoppedErrorRecord(),
    }));

    expect(html).toContain("prototype · 原型出口修正");
    expect(html).toContain("查看关联需求");
    expect(html).toContain("问题前后的行为");
    expect(html).toContain("出现错误");
    expect(html).toContain("开始 10:38:12 · 结束 10:43:06 · 共 4分54秒");
    const record = html.slice(html.indexOf('id="record"'));
    expect(record.indexOf("形成操作型界面的设计计划")).toBeLessThan(record.indexOf("连接在确认前断开"));
    expect(record.indexOf("连接在确认前断开")).toBeLessThan(record.indexOf("保持待办为"));
    expect(record).toContain("class=\"step error\"");
    expect(html).not.toContain("Daily cost summary completed");
  });

  it("@scenario S-R237511TR-01-empty 没有命中时清掉旧结果与旧全文并给出修改办法", () => {
    const empty = reduceWorkRecordScreen(
      reduceWorkRecordScreen(
        readyState(query({ keyword: "费用超限后停止" }), [match()]),
        { type: "search_started", request: request("r2", query({ keyword: "费用超限后停止" })) },
      ),
      { type: "search_succeeded", requestId: "r2", result: { query: query({ keyword: "费用超限后停止" }), matches: [], snapshotAt: NOW } },
    );

    expect(empty.kind).toBe("empty");
    const html = renderWorkRecordsPage(empty);
    expect(html).toContain("没有匹配的工作记录");
    expect(html).toContain("修改搜索条件");
    expect(html).not.toContain("原型出口修正");
    expect(html).not.toContain("读取已批准的页面清单与场景");
  });

  it("@scenario S-R237511TR-01-loading 搜索未返回时写明范围且不显示上一次结果", () => {
    const loading = reduceWorkRecordScreen(
      readyState(query(), [match({ name: "周期性优化" })]),
      { type: "search_started", request: request("r3", query()) },
    );

    expect(loading.kind).toBe("loading");
    const html = renderWorkRecordsPage(loading);
    // The sentence is a heading and the live region is the card around it.
    // A role="status" on the h2 replaces the heading role, so the title the
    // DoD declares cannot be found by anything that reads the page structure.
    expect(html).toContain('<div class="state-card" role="status"><h2>正在搜索完整工作记录</h2>');
    expect(html).toContain("正在查找最近 24 小时内包含“Notion 保存失败”的记录，请稍候。");
    expect(html).not.toContain("周期性优化");
    // A search is an in-place change: the browser swaps the view to the loading
    // notice the moment the form is submitted, before the read comes back, so
    // the previous result is gone from the first frame rather than after a
    // navigation. The document a scripting-off browser gets is unchanged.
    expect(html).toContain('id="records-view"');
    expect(html).toContain('class="toolbar record-search"');
    expect(html).toContain("getElementById('records-view')");
    expect(html).toContain("'<h2>正在搜索完整工作记录</h2>'");
    expect(html).toContain("'正在查找' + rangeLabel(c.range) + '内包含“' + escapeHtml(c.keyword) + '”的记录，请稍候。'");
  });

  it("@scenario S-R237511TR-02-loading 空关键词读取时说明正在读取最近二十四小时内全部角色的工作记录", () => {
    const browse = query({ keyword: "" });
    const loading = reduceWorkRecordScreen(
      { kind: "idle", draft: browse },
      { type: "search_started", request: request("browse-1", browse) },
    );

    expect(loading.kind).toBe("loading");
    const html = renderWorkRecordsPage(loading);
    expect(html).toContain("正在读取最近 24 小时内全部角色的工作记录");
    expect(html).toContain("工作记录排查");
    expect(html).toContain('<option value="24h" selected>最近 24 小时</option>');
    expect(html).toContain('<option value="" selected>全部角色</option>');
    expect(html).not.toContain("周期性优化");
  });

  it("@scenario S-R237511TR-01-error 读取失败后保留三个条件并可重新搜索且不显示旧结果", () => {
    const failed = reduceWorkRecordScreen(
      reduceWorkRecordScreen(
        readyState(query({ role: "prototype" }), [match({ role: "engineer", name: "同步任务" })]),
        { type: "search_started", request: request("r4", query({ role: "prototype" })) },
      ),
      { type: "search_failed", requestId: "r4", code: "unavailable", retryable: true },
    );

    expect(failed.kind).toBe("failed");
    const html = renderWorkRecordsPage(failed);
    expect(html).toContain("<h2>无法搜索工作记录</h2>");
    expect(html).toContain("<button type=\"submit\">重新搜索</button>");
    expect(html).toContain("value=\"Notion 保存失败\"");
    expect(html).toContain("value=\"prototype\" selected");
    expect(html).toContain("value=\"24h\" selected");
    expect(html).not.toContain("同步任务");
    expect(html).toContain("'<h2>无法搜索工作记录</h2>'");
    expect(html).toContain("'<button type=\"submit\">重新搜索</button></form></section>'");
    // The failed state is reachable on its own URL with the criteria it was
    // reached with, which is what lets a read failure be looked at rather than
    // only described.
    const reachable = renderWorkRecordsPage(readyState(query({ role: "prototype" }), [match()]));
    expect(reachable).toContain("页面状态");
    expect(reachable).toContain(`href="/records?keyword=Notion+%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5&role=prototype&range=24h&state=error"`);
    expect(reachable).toContain("state=loading");
    expect(reachable).toContain("state=waiting");
  });

  it("@scenario S-R237511TR-01-waiting 工作未结束时显示等待写入并保留已出现的行为", () => {
    const html = renderWorkRecordsPage(readyState(query(), [match({ runId: "run-working", role: "engineer", name: "同步任务" })], {
      kind: "ready",
      runId: "run-working",
      requestId: "s2",
      record: runningRecord(),
    }));

    expect(html).toContain("正在等待最新记录写入");
    expect(html).toContain("页面会自动刷新，已有片段不会丢失");
    expect(html).toContain("Opened the todo");
    expect(html).toContain("准备重试");
    // The waiting record itself never says the work finished. The refresh
    // script names the finished result it will write when it arrives, and a
    // script is not part of the screen the assertion is about.
    expect(html.slice(0, html.indexOf("<script>"))).not.toContain("已完成");
  });

  it("@scenario S-R237511TR-01-mobile 手机上先结果后全文且单列阅读关键信息", () => {
    const html = renderWorkRecordsPage(readyState(query(), [
      match({ runId: "run-one", name: "周期性优化" }),
      match({ runId: "run-selected" }),
    ], { kind: "ready", runId: "run-selected", requestId: "s3", record: stoppedErrorRecord() }));

    expect(html).toContain("aria-label=\"手机导航\"");
    expect(html).toContain("aria-current=\"page\" href=\"/records\">记录</a>");
    expect(html).toContain("匹配记录");
    expect(html).toContain("出现错误");
    expect(html).toContain("形成操作型界面的设计计划");
    expect(html).toContain("保持待办为");
    expect(html).toContain("@media (max-width:760px)");
    expect(html).toContain(".record-split{grid-template-columns:1fr}");
  });

  it("@scenario S-R237511TR-02-mobile 手机上筛选、结果与完整记录按顺序单列且底部把记录标为当前", () => {
    const html = renderWorkRecordsPage(readyState(query({ keyword: "" }), [
      match({ runId: "run-running", name: "周期性优化", status: { kind: "running" } }),
      match({ runId: "run-selected", status: { kind: "stopped", outcome: "error", stoppedAt: NOW } }),
    ], { kind: "ready", runId: "run-selected", requestId: "s4", record: stoppedErrorRecord() }));

    expect(html.indexOf('class="toolbar record-search"')).toBeLessThan(html.indexOf("匹配记录"));
    expect(html.indexOf("匹配记录")).toBeLessThan(html.indexOf("完整工作记录"));
    expect(html).toContain("aria-label=\"手机导航\"");
    expect(html).toContain("aria-current=\"page\" href=\"/records\">记录</a>");
    expect(html).toContain("@media (max-width:760px)");
    expect(html).toContain(".record-split{grid-template-columns:1fr}");
  });

  it("@scenario S-R237511TR-02-recent 每条结果所在的列表用这次工作的名字作名称", () => {
    const html = renderWorkRecordsPage(readyState(query({ keyword: "" }), [
      match({ role: "prototype", name: "周期性优化" }),
    ]));

    expect(html).toContain('<ol class="result-fields" aria-labelledby="record-name-0">');
    expect(html).toContain('<span id="record-name-0" hidden>记录 prototype · 周期性优化</span>');
    // The visible title still comes first, so the row reads the same way it
    // did before the list had a name.
    expect(html.indexOf("<strong>prototype · 周期性优化</strong>")).toBeLessThan(html.indexOf("<span id=\"record-name-0\""));
  });

  it("@scenario S-R237511TR-02-errors 出错那一行所在的列表同样带着这次工作的名字", () => {
    const html = renderWorkRecordsPage(readyState(query({ keyword: "" }), [
      match({ runId: "run-selected", status: { kind: "stopped", outcome: "error", stoppedAt: NOW } }),
    ]));

    expect(html).toContain('<span id="record-name-0" hidden>记录 prototype · 原型出口修正</span>');
    expect(html).toContain('class="status danger" role="status">出现错误');
  });

  it("@scenario S-R237511TR-02-filter 两个下拉把当前选择写进自己的可访问名称", () => {
    const html = renderWorkRecordsPage(readyState(query({ keyword: "", role: "engineer" }), [
      match({ role: "engineer", name: "周期性优化" }),
    ]));

    expect(html).toContain('aria-label="智能体角色，当前 engineer"');
    expect(html).toContain('aria-label="发生时间，当前 最近 24 小时"');
    expect(html).toContain('<span id="record-name-0" hidden>记录 engineer · 周期性优化</span>');
  });

  it("@scenario S-R237511TR-02-live 运行中记录的每条行为是带着时间的日志区", () => {
    const html = renderWorkRecordsPage(readyState(query({ keyword: "", role: "engineer" }), [
      match({ runId: "run-working", role: "engineer", name: "周期性优化" }),
    ], { kind: "ready", runId: "run-working", requestId: "s-live", record: runningRecord() }));

    expect(html).toContain('role="log" aria-label="11:59:00 Work started"');
    expect(html).toContain("后续内容会自动出现");
    // The cursors the browser asks the next slice with, and the log it appends
    // to, are on the record itself; without them the watch has nothing to name.
    expect(html).toContain('data-run-id="run-working"');
    expect(html).toContain('data-through-sequence="3"');
    expect(html).toContain('id="record-log"');
    expect(html).toContain("'/api/work-records/' + encodeURIComponent(runId)");
  });

  it("@scenario S-R237511TR-02-mobile 底部导航为当前项单独命名且完整记录带标题", () => {
    const html = renderWorkRecordsPage(readyState(query({ keyword: "" }), [match()], {
      kind: "ready",
      runId: "run-selected",
      requestId: "s-mobile-named",
      record: stoppedErrorRecord(),
    }));

    expect(html).toContain('<nav class="mobile-current" aria-label="记录">');
    expect(html).toContain('<h2 class="version-label">完整工作记录</h2>');
  });
});

describe("work record formatting", () => {
  it("names the range a search covered and the duration a record ran", () => {
    expect(workRecordRangeLabel(NOW - DAY, NOW)).toBe("最近 24 小时");
    expect(workRecordRangeLabel(NOW - 7 * DAY, NOW)).toBe("最近 7 天");
    expect(workRecordRangeLabel(0, NOW)).toBe("全部时间");
    expect(formatWorkRecordDuration(294_000)).toBe("4分54秒");
  });
});
