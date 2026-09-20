import { describe, expect, it } from "vitest";
import {
  reduceWorkRecordScreen,
  renderWorkRecordsPage,
  type WorkRecordSearchRequest,
  type WorkRecordSearchState,
} from "./work-records.js";
import type { WorkRecordSearchQuery } from "../observability/work-record-reader.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function query(keyword: string, role?: string): WorkRecordSearchQuery {
  return {
    keyword,
    ...(role === undefined ? {} : { role }),
    fromInclusive: NOW - DAY,
    toExclusive: NOW,
  };
}

function request(requestId: string, search: WorkRecordSearchQuery): WorkRecordSearchRequest {
  return { requestId, query: search };
}

function loading(search: WorkRecordSearchQuery): WorkRecordSearchState {
  return reduceWorkRecordScreen(
    { kind: "idle", draft: search },
    { type: "search_started", request: request("search-1", search) },
  );
}

function failed(search: WorkRecordSearchQuery): WorkRecordSearchState {
  return reduceWorkRecordScreen(
    loading(search),
    { type: "search_failed", requestId: "search-1", code: "unavailable", retryable: true },
  );
}

function visibleState(state: WorkRecordSearchState): string {
  const html = renderWorkRecordsPage(state);
  return html.slice(html.indexOf('<div id="records-view">'), html.indexOf("</main>"));
}

describe("work record search state wording", () => {
  it("@scenario S-R237511TR-01-loading 关键词搜索期间说明正在搜索完整记录及范围", () => {
    const html = visibleState(loading(query("Notion 保存失败")));

    expect(html).toContain("正在搜索完整工作记录");
    expect(html).toContain("正在查找最近 24 小时内包含“Notion 保存失败”的记录，请稍候。");
  });

  it("@scenario S-R237511TR-01-loading 空关键词读取与关键词搜索使用不同提示", () => {
    const html = visibleState(loading(query("")));

    expect(html).toContain("正在读取最近 24 小时内全部角色的工作记录");
    expect(html).not.toContain("正在搜索完整工作记录");
  });

  it("@scenario S-R237511TR-01-error 关键词搜索失败时提供重新搜索", () => {
    const html = visibleState(failed(query("Notion 保存失败", "prototype")));

    expect(html).toContain("无法搜索工作记录");
    expect(html).toContain("重新搜索");
    expect(html).toContain('value="Notion 保存失败"');
    expect(html).toContain('value="prototype"');
    expect(html).toContain('value="24h"');
  });

  it("@scenario S-R237511TR-01-error 空关键词读取失败与关键词搜索失败使用不同动作", () => {
    const html = visibleState(failed(query("")));

    expect(html).toContain("无法读取工作记录");
    expect(html).toContain("重新读取");
    expect(html).not.toContain("无法搜索工作记录");
  });
});
