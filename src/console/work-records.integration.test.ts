import { describe, expect, it } from "vitest";
import {
  loadWorkRecordScreen,
  reduceWorkRecordScreen,
  renderWorkRecordsPage,
  renderWorkRecordsRoute,
  type WorkRecordSearchRequest,
  type WorkRecordSearchState,
} from "./work-records.js";
import type {
  WorkRecordDetail,
  WorkRecordMatch,
  WorkRecordReader,
  WorkRecordSearchQuery,
  WorkRecordSearchResult,
} from "../observability/work-record-reader.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;

function query(overrides: Partial<WorkRecordSearchQuery> = {}): WorkRecordSearchQuery {
  return {
    keyword: "",
    fromInclusive: NOW - DAY,
    toExclusive: NOW,
    ...overrides,
  };
}

function match(
  runId: string,
  role: string,
  occurredAt: number,
  status: WorkRecordMatch["status"],
): WorkRecordMatch {
  return {
    runId,
    role,
    name: `${role} periodic optimization`,
    occurredAt,
    status,
    requirement: { id: `R-${runId}`, title: `Requirement ${runId}` },
    hit: [],
  };
}

function result(searchQuery: WorkRecordSearchQuery, matches: readonly WorkRecordMatch[]): WorkRecordSearchResult {
  return { query: searchQuery, matches, snapshotAt: NOW };
}

function detail(runId: string, status: WorkRecordDetail["status"]): WorkRecordDetail {
  return {
    runId,
    role: "engineer",
    name: "Periodic optimization",
    requirement: { id: "R-live", title: "Live work" },
    startedAt: NOW - 120_000,
    status,
    steps: [
      {
        runId,
        sequence: 1,
        occurredAt: NOW - 120_000,
        kind: "start",
        text: { value: "Read current task", redaction: "applied" },
      },
    ],
    throughSequence: 1,
  };
}

function readerForSearch(
  search: (searchQuery: WorkRecordSearchQuery) => Promise<WorkRecordSearchResult>,
): WorkRecordReader {
  return {
    search,
    read: async () => {
      throw new Error("detail is not expected in this test");
    },
  };
}

function request(searchQuery: WorkRecordSearchQuery): WorkRecordSearchRequest {
  return { requestId: "request-1", query: searchQuery };
}

function resultItem(html: string, name: string): string {
  const nameAt = html.indexOf(name);
  expect(nameAt).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<li", nameAt);
  const end = html.indexOf("</li>", nameAt);
  return html.slice(start, end + 5);
}

describe("work records browse screen", () => {
  it("@scenario S-R237511TR-02-recent \u6253\u5f00\u5165\u53e3\u65f6\u63d0\u4ea4\u7a7a\u5173\u952e\u8bcd\u3001\u5168\u90e8\u89d2\u8272\u548c\u6700\u8fd1\u4e8c\u5341\u56db\u5c0f\u65f6", async () => {
    let submitted: WorkRecordSearchQuery | undefined;
    const reader = readerForSearch(async (searchQuery) => {
      submitted = searchQuery;
      return result(searchQuery, []);
    });

    const state = await loadWorkRecordScreen(reader, {}, NOW);

    expect(state.kind).toBe("empty");
    expect(submitted).toEqual({ keyword: "", fromInclusive: NOW - DAY, toExclusive: NOW });
  });

  it("@scenario S-R237511TR-02-recent \u7a7a\u5173\u952e\u8bcd\u5165\u53e3\u4e0d\u5f97\u9884\u586b\u65e7\u7684\u6545\u969c\u641c\u7d22\u8bcd", async () => {
    const reader = readerForSearch(async (searchQuery) => result(searchQuery, []));

    const html = await renderWorkRecordsRoute(reader, {}, NOW);

    expect(html).toContain('name="keyword" type="search" value=""');
    expect(html).not.toContain('value="Notion \u4fdd\u5b58\u5931\u8d25"');
  });

  it("@scenario S-R237511TR-02-filter \u7b5b\u9009\u5b8c\u6210\u540e\u7ee7\u7eed\u663e\u793a engineer \u548c\u6700\u8fd1\u4e8c\u5341\u56db\u5c0f\u65f6", () => {
    const selectedQuery = query({ role: "engineer" });
    const state: WorkRecordSearchState = {
      kind: "ready",
      request: request(selectedQuery),
      result: result(selectedQuery, [match("recent", "engineer", NOW - 1_000, { kind: "running" })]),
      selection: { kind: "none" },
    };

    const html = renderWorkRecordsPage(state);

    expect(html).toContain('<option value="engineer" selected>engineer</option>');
    expect(html).toContain('<option value="24h" selected>\u6700\u8fd1 24 \u5c0f\u65f6</option>');
    expect(html).toContain("engineer \u00b7 engineer periodic optimization");
  });

  it("@scenario S-R237511TR-02-filter \u5df2\u663e\u793a\u7684\u6761\u4ef6\u4e0d\u5f97\u56de\u9000\u4e3a\u5168\u90e8\u89d2\u8272\u6216\u6700\u8fd1\u4e03\u5929", () => {
    const selectedQuery = query({ role: "engineer" });
    const state: WorkRecordSearchState = {
      kind: "empty",
      request: request(selectedQuery),
    };

    const html = renderWorkRecordsPage(state);

    expect(html).not.toContain('<option value="" selected>\u5168\u90e8\u89d2\u8272</option>');
    expect(html).not.toContain('<option value="7d" selected>\u6700\u8fd1 7 \u5929</option>');
  });

  it("@scenario S-R237511TR-02-errors \u7ed3\u679c\u5217\u8868\u7528\u6587\u5b57\u548c\u5bf9\u5e94\u989c\u8272\u5206\u522b\u6807\u51fa\u8fd0\u884c\u4e2d\u3001\u5df2\u5b8c\u6210\u548c\u51fa\u73b0\u9519\u8bef", () => {
    const searchQuery = query();
    const state: WorkRecordSearchState = {
      kind: "ready",
      request: request(searchQuery),
      result: result(searchQuery, [
        match("running", "engineer", NOW - 30_000, { kind: "running" }),
        match("completed", "prototype", NOW - 20_000, {
          kind: "stopped",
          outcome: "completed",
          stoppedAt: NOW - 20_000,
        }),
        match("errored", "prototype", NOW - 10_000, {
          kind: "stopped",
          outcome: "error",
          stoppedAt: NOW - 10_000,
        }),
      ]),
      selection: { kind: "none" },
    };

    const html = renderWorkRecordsPage(state);

    expect(resultItem(html, "engineer periodic optimization")).toMatch(/class="status running" role="status">\u8fd0\u884c\u4e2d/);
    expect(resultItem(html, "prototype periodic optimization")).toMatch(/class="status success" role="status">\u5df2\u5b8c\u6210/);
    const errorItem = resultItem(html.slice(html.indexOf("runId=errored")), "prototype periodic optimization");
    expect(errorItem).toMatch(/class="status danger" role="status">\u51fa\u73b0\u9519\u8bef/);
  });

  it("@scenario S-R237511TR-02-errors \u5df2\u5b8c\u6210\u7684\u5217\u8868\u9879\u4e0d\u5f97\u4f7f\u7528\u51fa\u9519\u6587\u5b57\u6216\u5371\u9669\u8272", () => {
    const searchQuery = query();
    const state: WorkRecordSearchState = {
      kind: "ready",
      request: request(searchQuery),
      result: result(searchQuery, [
        match("completed", "engineer", NOW - 20_000, {
          kind: "stopped",
          outcome: "completed",
          stoppedAt: NOW - 20_000,
        }),
      ]),
      selection: { kind: "none" },
    };

    const item = resultItem(renderWorkRecordsPage(state), "engineer periodic optimization");

    expect(item).toContain("\u5df2\u5b8c\u6210");
    expect(item).not.toContain("\u51fa\u73b0\u9519\u8bef");
    expect(item).not.toContain("status danger");
  });

  it("@scenario S-R237511TR-02-live \u6253\u5f00\u8fd0\u884c\u4e2d\u5de5\u4f5c\u65f6\u7acb\u5373\u663e\u793a\u5df2\u6709\u5185\u5bb9\u5e76\u8bf4\u660e\u540e\u7eed\u5185\u5bb9\u4f1a\u81ea\u52a8\u51fa\u73b0", () => {
    const searchQuery = query({ role: "engineer" });
    const record = detail("run-live", { kind: "running", refreshAfterMs: 5_000 });
    const state: WorkRecordSearchState = {
      kind: "ready",
      request: request(searchQuery),
      result: result(searchQuery, [match("run-live", "engineer", NOW - 120_000, { kind: "running" })]),
      selection: { kind: "ready", runId: "run-live", requestId: "selection-1", record },
    };

    const html = renderWorkRecordsPage(state);

    expect(html).toContain('class="status running" role="status">\u8fd0\u884c\u4e2d');
    expect(html).toContain("Read current task");
    expect(html).toContain("\u540e\u7eed\u5185\u5bb9\u4f1a\u81ea\u52a8\u51fa\u73b0");
    expect(html).not.toContain("\u7ed3\u675f 12:00:00");
  });

  it("@scenario S-R237511TR-02-live \u5df2\u7ed3\u675f\u5de5\u4f5c\u663e\u793a\u5b8c\u6210\u548c\u7ed3\u675f\u65f6\u95f4\u4e14\u4e0d\u518d\u663e\u793a\u7b49\u5f85\u63d0\u793a", () => {
    const searchQuery = query({ role: "engineer" });
    const record = detail("run-live", {
      kind: "stopped",
      outcome: "completed",
      stoppedAt: NOW,
      durationMs: 120_000,
    });
    const state: WorkRecordSearchState = {
      kind: "ready",
      request: request(searchQuery),
      result: result(searchQuery, [
        match("run-live", "engineer", NOW, { kind: "stopped", outcome: "completed", stoppedAt: NOW }),
      ]),
      selection: { kind: "ready", runId: "run-live", requestId: "selection-1", record },
    };

    const html = renderWorkRecordsPage(state);

    expect(html).toContain('class="status success" role="status">\u5df2\u5b8c\u6210');
    expect(html).toContain("\u7ed3\u675f 12:00:00");
    expect(html).not.toContain("\u540e\u7eed\u5185\u5bb9\u4f1a\u81ea\u52a8\u51fa\u73b0");
  });

  it("@scenario S-R237511TR-02-empty \u65e0\u7ed3\u679c\u65f6\u4fdd\u7559\u6240\u9009\u6761\u4ef6\u5e76\u7ed9\u51fa\u4e09\u79cd\u8c03\u6574\u5efa\u8bae", async () => {
    let submitted: WorkRecordSearchQuery | undefined;
    const reader = readerForSearch(async (searchQuery) => {
      submitted = searchQuery;
      return result(searchQuery, []);
    });

    const html = await renderWorkRecordsRoute(reader, { keyword: "", role: "prototype", range: "24h" }, NOW);

    expect(submitted).toEqual({
      keyword: "",
      role: "prototype",
      fromInclusive: NOW - DAY,
      toExclusive: NOW,
    });
    expect(html).toContain("\u6ca1\u6709\u5339\u914d\u7684\u5de5\u4f5c\u8bb0\u5f55");
    expect(html).toContain("\u6269\u5927\u65f6\u95f4\u8303\u56f4");
    expect(html).toContain("\u5168\u90e8\u89d2\u8272");
    expect(html).toContain("\u5173\u952e\u8bcd");
    expect(html).toContain('<option value="prototype" selected>prototype</option>');
    expect(html).toContain('<option value="24h" selected>\u6700\u8fd1 24 \u5c0f\u65f6</option>');
  });

  it("@scenario S-R237511TR-02-empty \u7a7a\u7ed3\u679c\u4e0d\u5f97\u663e\u793a\u4efb\u4f55\u5360\u4f4d\u5de5\u4f5c\u8bb0\u5f55", () => {
    const state: WorkRecordSearchState = { kind: "empty", request: request(query({ role: "prototype" })) };

    const html = renderWorkRecordsPage(state);

    expect(html).not.toContain('<ol class="result-list">');
    expect(html).not.toContain("\u865a\u6784\u7684\u5de5\u4f5c\u8bb0\u5f55");
    expect(html).toContain("\u4fee\u6539\u641c\u7d22\u6761\u4ef6");
  });

  it("@scenario S-R237511TR-02-retry \u8bfb\u53d6\u5931\u8d25\u65f6\u663e\u793a\u539f\u6761\u4ef6\u548c\u91cd\u65b0\u8bfb\u53d6\u52a8\u4f5c", () => {
    const failedQuery = query({ keyword: "\u5468\u671f\u6027\u4f18\u5316", role: "engineer", fromInclusive: NOW - 7 * DAY });
    const state: WorkRecordSearchState = {
      kind: "failed",
      request: request(failedQuery),
      code: "unavailable",
      retryable: true,
    };

    const html = renderWorkRecordsPage(state);

    expect(html).toContain("\u65e0\u6cd5\u8bfb\u53d6\u5de5\u4f5c\u8bb0\u5f55");
    expect(html).toContain(">\u91cd\u65b0\u8bfb\u53d6</button>");
    expect(html).toContain('name="keyword" value="\u5468\u671f\u6027\u4f18\u5316"');
    expect(html).toContain('name="role" value="engineer"');
    expect(html).toContain('name="range" value="7d"');
    expect(html).toContain('<option value="engineer" selected>engineer</option>');
    expect(html).toContain('<option value="7d" selected>\u6700\u8fd1 7 \u5929</option>');
  });

  it("@scenario S-R237511TR-02-retry \u91cd\u65b0\u8bfb\u53d6\u7ee7\u7eed\u4f7f\u7528\u5931\u8d25\u524d\u7684\u6761\u4ef6\u800c\u4e0d\u6062\u590d\u9ed8\u8ba4\u503c", () => {
    const failedQuery = query({ keyword: "\u5468\u671f\u6027\u4f18\u5316", role: "engineer", fromInclusive: NOW - 7 * DAY });
    const originalRequest = request(failedQuery);
    const failed: WorkRecordSearchState = {
      kind: "failed",
      request: originalRequest,
      code: "unavailable",
      retryable: true,
    };

    const retried = reduceWorkRecordScreen(failed, { type: "search_started", request: originalRequest });

    expect(retried).toEqual({ kind: "loading", request: originalRequest });
    expect(retried.kind === "loading" && retried.request.query).toEqual(failedQuery);
    expect(retried.kind === "loading" && retried.request.query).not.toMatchObject({ role: undefined, keyword: "" });
  });
});
