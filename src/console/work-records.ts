import type { FastifyInstance } from "fastify";
import {
  WorkRecordReadError,
  type WorkRecordDetail,
  type WorkRecordDetailQuery,
  type WorkRecordReadFailureCode,
  type WorkRecordReader,
  type WorkRecordSearchQuery,
  type WorkRecordSearchResult,
  type WorkRecordSummaryStatus,
} from "../observability/work-record-reader.js";

export interface WorkRecordSearchRequest {
  requestId: string;
  query: WorkRecordSearchQuery;
}

export interface WorkRecordBrowseDefaults {
  keyword: "";
  role: "all";
  range: "24h";
}

/** The landing criteria are a browse request, not a synthetic keyword search:
 * a person opens the screen and sees what happened lately without first
 * having to guess a phrase. */
export const WORK_RECORD_BROWSE_DEFAULTS: Readonly<WorkRecordBrowseDefaults> = {
  keyword: "",
  role: "all",
  range: "24h",
};

export interface WorkRecordLiveRefreshRequest {
  /** Identifies the selection that scheduled this refresh. */
  selectionRequestId: string;
  runId: string;
  /** The last sequence already rendered; only a continuation may be requested. */
  afterSequence: number;
}

export type WorkRecordLiveRefreshState =
  | { kind: "idle" }
  | { kind: "scheduled"; request: WorkRecordLiveRefreshRequest; afterMs: number }
  | { kind: "reading"; request: WorkRecordLiveRefreshRequest }
  | {
      kind: "retry_wait";
      request: WorkRecordLiveRefreshRequest;
      code: WorkRecordReadFailureCode;
      afterMs: number;
    }
  | { kind: "stopped" };

export type WorkRecordSearchState =
  | { kind: "idle"; draft: WorkRecordSearchQuery }
  | { kind: "loading"; request: WorkRecordSearchRequest }
  | { kind: "empty"; request: WorkRecordSearchRequest }
  | {
      kind: "failed";
      request: WorkRecordSearchRequest;
      code: WorkRecordReadFailureCode;
      retryable: boolean;
    }
  | {
      kind: "ready";
      request: WorkRecordSearchRequest;
      result: WorkRecordSearchResult;
      selection: WorkRecordSelectionState;
    };

export type WorkRecordSelectionState =
  | { kind: "none" }
  | { kind: "loading"; runId: string; requestId: string }
  | {
      kind: "failed";
      runId: string;
      requestId: string;
      code: WorkRecordReadFailureCode;
      retryable: boolean;
    }
  | {
      kind: "ready";
      runId: string;
      requestId: string;
      record: WorkRecordDetail;
      /** At most one refresh may read this selected run at a time. */
      liveRefresh?: WorkRecordLiveRefreshState;
    };

export type WorkRecordScreenEvent =
  | { type: "search_started"; request: WorkRecordSearchRequest }
  | { type: "search_succeeded"; requestId: string; result: WorkRecordSearchResult }
  | {
      type: "search_failed";
      requestId: string;
      code: WorkRecordReadFailureCode;
      retryable: boolean;
    }
  | { type: "selection_started"; runId: string; requestId: string }
  | { type: "selection_succeeded"; requestId: string; record: WorkRecordDetail }
  | {
      type: "selection_failed";
      requestId: string;
      code: WorkRecordReadFailureCode;
      retryable: boolean;
    }
  | { type: "active_record_refreshed"; runId: string; record: WorkRecordDetail };

/**
 * The browser owns drafts, submitted criteria, and selection. Starting a search
 * drops the previous result and detail; requestId prevents an older response
 * from restoring stale content after a newer search. A response that does not
 * match the in-flight request is discarded whole rather than merged in part:
 * a stale list, a stale selection and a stale read all arrive the same way.
 */
export function reduceWorkRecordScreen(
  state: WorkRecordSearchState,
  event: WorkRecordScreenEvent,
): WorkRecordSearchState {
  switch (event.type) {
    case "search_started":
      return { kind: "loading", request: event.request };
    case "search_succeeded": {
      if (state.kind !== "loading" || state.request.requestId !== event.requestId) return state;
      if (event.result.matches.length === 0) return { kind: "empty", request: state.request };
      return { kind: "ready", request: state.request, result: event.result, selection: { kind: "none" } };
    }
    case "search_failed": {
      if (state.kind !== "loading" || state.request.requestId !== event.requestId) return state;
      return { kind: "failed", request: state.request, code: event.code, retryable: event.retryable };
    }
    case "selection_started": {
      if (state.kind !== "ready") return state;
      return { ...state, selection: { kind: "loading", runId: event.runId, requestId: event.requestId } };
    }
    case "selection_succeeded": {
      if (state.kind !== "ready" || state.selection.kind !== "loading") return state;
      if (state.selection.requestId !== event.requestId) return state;
      return { ...state, selection: { kind: "ready", runId: event.record.runId, requestId: event.requestId, record: event.record } };
    }
    case "selection_failed": {
      if (state.kind !== "ready" || state.selection.kind !== "loading") return state;
      if (state.selection.requestId !== event.requestId) return state;
      return {
        ...state,
        selection: { kind: "failed", runId: state.selection.runId, requestId: event.requestId, code: event.code, retryable: event.retryable },
      };
    }
    case "active_record_refreshed": {
      if (state.kind !== "ready" || state.selection.kind !== "ready") return state;
      if (state.selection.runId !== event.runId) return state;
      return { ...state, selection: { ...state.selection, record: event.record } };
    }
  }
}

export interface WorkRecordRouteOptions {
  /** The API may cap ranges and result counts without changing literal-match semantics. */
  maximumRangeMs: number;
  maximumResults: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The query string parameters `/records` reads, alongside the four states. */
export interface WorkRecordsRouteParameters {
  keyword?: string;
  role?: string;
  range?: string;
  runId?: string;
  /** One of empty | loading | error | waiting names a state on its own URL. */
  state?: string;
}

function failureStatus(code: WorkRecordReadFailureCode): number {
  switch (code) {
    case "invalid_query": return 400;
    case "not_found": return 404;
    case "unavailable": return 503;
  }
}

function failureBody(cause: unknown): { error: string; code: WorkRecordReadFailureCode; retryable: boolean } {
  if (cause instanceof WorkRecordReadError) {
    return { error: cause.message, code: cause.code, retryable: cause.retryable };
  }
  return {
    error: cause instanceof Error ? cause.message : String(cause),
    code: "unavailable",
    retryable: true,
  };
}

/**
 * Registers GET /api/work-records and GET /api/work-records/:runId. Read
 * failures map to stable codes; no endpoint mutates or controls a work run.
 */
export async function registerWorkRecordRoutes(
  app: FastifyInstance,
  reader: WorkRecordReader,
  options: WorkRecordRouteOptions,
): Promise<void> {
  app.get("/api/work-records", async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const toExclusive = Number(raw.to ?? Date.now());
    const fromInclusive = Number(raw.from ?? toExclusive - HOUR_MS * 24);
    const query: WorkRecordSearchQuery = {
      keyword: raw.keyword ?? "",
      ...(raw.role ? { role: raw.role } : {}),
      fromInclusive,
      toExclusive,
    };
    if (!Number.isFinite(fromInclusive) || !Number.isFinite(toExclusive) || toExclusive - fromInclusive > options.maximumRangeMs) {
      return reply.code(400).send({ error: "the requested range is outside what the API serves", code: "invalid_query", retryable: false });
    }
    try {
      const result = await reader.search(query);
      return { ...result, matches: result.matches.slice(0, options.maximumResults) };
    } catch (cause) {
      const body = failureBody(cause);
      return reply.code(failureStatus(body.code)).send(body);
    }
  });

  app.get("/api/work-records/:runId", async (request, reply) => {
    const runId = (request.params as { runId?: string }).runId ?? "";
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const afterSequence = raw.afterSequence === undefined ? undefined : Number(raw.afterSequence);
    const query: WorkRecordDetailQuery = { runId, ...(afterSequence === undefined ? {} : { afterSequence }) };
    try {
      return await reader.read(query);
    } catch (cause) {
      const body = failureBody(cause);
      return reply.code(failureStatus(body.code)).send(body);
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function currentQuery(state: WorkRecordSearchState): WorkRecordSearchQuery {
  return state.kind === "idle" ? state.draft : state.request.query;
}

/** The label a person reads for the half-open range a search ran over. */
export function workRecordRangeLabel(fromInclusive: number, toExclusive: number): string {
  const span = toExclusive - fromInclusive;
  if (span <= HOUR_MS * 24) return "最近 24 小时";
  if (span <= HOUR_MS * 24 * 7) return "最近 7 天";
  return "全部时间";
}

function rangeValue(query: WorkRecordSearchQuery): "24h" | "7d" | "all" {
  const span = query.toExclusive - query.fromInclusive;
  if (span <= HOUR_MS * 24) return "24h";
  if (span <= HOUR_MS * 24 * 7) return "7d";
  return "all";
}

/** Minutes and seconds a work record ran, for example `4分54秒`. */
export function formatWorkRecordDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`;
}

function formatClock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

/** The URL a result links at: the same search with one run selected. */
function recordsHref(query: WorkRecordSearchQuery, runId: string): string {
  const params = new URLSearchParams();
  params.set("keyword", query.keyword);
  if (query.role !== undefined) params.set("role", query.role);
  params.set("range", rangeValue(query));
  params.set("runId", runId);
  return `/records?${params.toString()}`;
}

function renderHit(hit: readonly { value: string; matched: boolean }[]): string {
  return hit
    .map((part) => (part.matched ? `<mark class="hit">${escapeHtml(part.value)}</mark>` : escapeHtml(part.value)))
    .join("");
}

function renderSearchForm(query: WorkRecordSearchQuery): string {
  const role = query.role ?? "";
  const range = rangeValue(query);
  const roleOption = (value: string, label: string): string =>
    `<option value="${value}"${role === value ? " selected" : ""}>${label}</option>`;
  const rangeOption = (value: string, label: string): string =>
    `<option value="${value}"${range === value ? " selected" : ""}>${label}</option>`;
  return `<form class="toolbar record-search" method="get" action="/records" role="search">`
    + `<div><label for="log-query">搜索工作记录</label>`
    + `<input id="log-query" name="keyword" type="search" value="${escapeHtml(query.keyword)}" placeholder="输入错误、动作或关键词"></div>`
    + `<div><label for="log-role">智能体角色</label><select id="log-role" name="role">`
    + roleOption("", "全部角色") + roleOption("prototype", "prototype") + roleOption("engineer", "engineer")
    + `</select></div>`
    + `<div><label for="log-time">发生时间</label><select id="log-time" name="range">`
    + rangeOption("24h", "最近 24 小时") + rangeOption("7d", "最近 7 天") + rangeOption("all", "全部时间")
    + `</select></div>`
    + `<button type="submit">搜索记录</button></form>`;
}

/** The four states the interface contract names, and the way back to a search. */
const STATE_LINKS: readonly { value: string; label: string }[] = [
  { value: "", label: "默认" },
  { value: "loading", label: "加载中" },
  { value: "empty", label: "没有匹配" },
  { value: "error", label: "读取失败" },
  { value: "waiting", label: "等待写入" },
];

/** The same search criteria carried onto one of the four states' own URL. */
function stateHref(query: WorkRecordSearchQuery, state: string): string {
  const params = new URLSearchParams();
  params.set("keyword", query.keyword);
  if (query.role !== undefined) params.set("role", query.role);
  params.set("range", rangeValue(query));
  if (state !== "") params.set("state", state);
  return `/records?${params.toString()}`;
}

/**
 * The four complete states are part of the interface contract, and a forced
 * state is only reachable if its URL is on the page rather than in somebody's
 * head. Each entry keeps the criteria the person already typed, so switching
 * to a state never throws away what the search was about.
 */
function renderStateLinks(query: WorkRecordSearchQuery): string {
  return `<p class="state-links"><span>页面状态</span>`
    + STATE_LINKS.map((link) => `<a href="${stateHref(query, link.value)}">${link.label}</a>`).join("")
    + `</p>`;
}

function renderMatchStatus(status: WorkRecordSummaryStatus): string {
  return status.kind === "running"
    ? `<span class="status running" role="status">运行中</span>`
    : statusChip("stopped", status.outcome);
}

/** One status chip, used by both the list and the complete record so the same
 * state never reads two different ways. The words always accompany the
 * colour; a reader who cannot tell the colours apart still sees the state. */
function statusChip(kind: "running" | "stopped", outcome?: "completed" | "error" | "stopped"): string {
  if (kind === "running") return `<span class="status running" role="status">运行中</span>`;
  switch (outcome) {
    case "error": return `<span class="status danger" role="status">出现错误</span>`;
    case "completed": return `<span class="status success" role="status">已完成</span>`;
    default: return `<span class="status" role="status">已停止</span>`;
  }
}

function renderResultItem(match: WorkRecordSearchResult["matches"][number], query: WorkRecordSearchQuery): string {
  // The row is one link around the fields it shows. Keeping the fields in
  // their own list lets each one carry a label on a phone without hiding what
  // the row is about.
  return `<li class="result"><a class="result-link" href="${recordsHref(query, match.runId)}"><ol class="result-fields">`
    + `<li class="result-head"><strong>${escapeHtml(match.role)} · ${escapeHtml(match.name)}</strong>${renderMatchStatus(match.status)}</li>`
    + `<li class="result-meta"><span class="meta">${formatClock(match.occurredAt)} · ${escapeHtml(match.requirement.title)}</span></li>`
    + `<li class="result-hit">命中：${renderHit(match.hit)}</li>`
    + `</ol></a></li>`;
}

function renderResults(result: WorkRecordSearchResult): string {
  return `<section class="panel flush" aria-labelledby="results-title"><div class="section-head">`
    + `<div><h2 id="results-title">匹配记录</h2><p>找到 ${result.matches.length} 条完整记录</p></div></div>`
    + `<ol class="result-list">${result.matches.map((match) => renderResultItem(match, result.query)).join("")}</ol></section>`;
}

function renderRecord(record: WorkRecordDetail): string {
  const status = record.status;
  const chip = statusChip(status.kind, status.kind === "stopped" ? status.outcome : undefined);
  const meta = status.kind === "running"
    ? `开始 ${formatClock(record.startedAt)} · 仍在进行`
    : `开始 ${formatClock(record.startedAt)} · 结束 ${formatClock(status.stoppedAt)} · 共 ${formatWorkRecordDuration(status.durationMs)}`;
  const steps = record.steps
    .map((step) => `<li class="step ${step.kind}" data-kind="${step.kind}">`
      + `<time datetime="${new Date(step.occurredAt).toISOString()}">${formatClock(step.occurredAt)}</time> `
      + `<span>${escapeHtml(step.text.value)}</span></li>`)
    .join("");
  const waiting = status.kind === "running"
    ? `<div class="notice attention" role="status"><h2>正在等待最新记录写入</h2>`
      + `<p>匹配的智能体仍在工作，完整记录尚未结束；后续内容会自动出现，页面会自动刷新，已有片段不会丢失。</p></div>`
    : `<div class="notice attention"><h2>问题前后的行为</h2>`
      + `<p>失败前后按时间顺序保留，相邻行为没有被截断，其他工作的行为不会混入。</p></div>`;
  return `<article class="panel" id="record" aria-labelledby="record-title"><div class="section-head">`
    + `<div><div class="version-label">完整工作记录</div><h2 id="record-title">${escapeHtml(record.role)} · ${escapeHtml(record.name)}</h2></div>`
    + chip + `</div>`
    + `<div class="row"><span class="meta">${meta}</span>`
    + `<a href="/requirements/${encodeURIComponent(record.requirement.id)}">查看关联需求</a></div>`
    + `<hr class="divider"><ol class="log">${steps}</ol>`
    + `<hr class="divider">${waiting}</article>`;
}

function renderReady(state: Extract<WorkRecordSearchState, { kind: "ready" }>): string {
  const record = state.selection.kind === "ready" ? renderRecord(state.selection.record) : "";
  return `<div class="record-split" data-layout="split">${renderResults(state.result)}${record}</div>`;
}

function renderLoading(request: WorkRecordSearchRequest): string {
  const query = request.query;
  const range = workRecordRangeLabel(query.fromInclusive, query.toExclusive);
  // The notice names the range and roles being read, because those are the
  // criteria the person chose; when a keyword is set it names that instead of
  // pretending the read is a browse.
  const scope = query.keyword === ""
    ? `${range}内全部角色的工作记录`
    : `${range}内包含“${escapeHtml(query.keyword)}”的工作记录`;
  return `<section class="state-page" aria-live="polite"><div class="state-card" role="status">`
    + `<h2>正在读取${scope}</h2>`
    + `<p>请稍候。上一次范围的结果不会冒充本次结果。</p>`
    + `</div></section>`;
}

function renderEmpty(): string {
  return `<section class="state-page"><div class="state-card">`
    + `<h2>没有匹配的工作记录</h2>`
    + `<p>尝试扩大时间范围、改为“全部角色”，或调整关键词。</p>`
    + `<button type="button" class="secondary">修改搜索条件</button></div></section>`;
}

function renderFailed(request: WorkRecordSearchRequest): string {
  const query = request.query;
  return `<section class="state-page"><form class="state-card record-search" method="get" action="/records">`
    + `<input type="hidden" name="keyword" value="${escapeHtml(query.keyword)}">`
    + `<input type="hidden" name="role" value="${escapeHtml(query.role ?? "")}">`
    + `<input type="hidden" name="range" value="${rangeValue(query)}">`
    + `<h2>无法读取工作记录</h2>`
    + `<p>工作记录暂时无法取得。当前条件已保留，检查内网连接后可以直接重新读取。</p>`
    + `<button type="submit">重新读取</button></form></section>`;
}

function renderState(state: WorkRecordSearchState): string {
  switch (state.kind) {
    case "idle": return "";
    case "loading": return renderLoading(state.request);
    case "empty": return renderEmpty();
    case "failed": return renderFailed(state.request);
    case "ready": return renderReady(state);
  }
}

const RECORDS_PAGE_STYLE = [
  ":root{--color-action:#173f63;--color-attention:#a75b00;--color-border:#cbd5df;--color-danger:#b42318;",
  "--color-page:#f4f7fa;--color-surface:#fff;--color-surface-attention:#fff4df;--color-surface-danger:#fff0ef;",
  "--color-text:#172b3a;--color-text-muted:#526477;--font-interface:'IBM Plex Sans','Segoe UI',sans-serif;",
  "--font-numeric:'IBM Plex Mono','SFMono-Regular',monospace;--space-gutter:28px;--space-gap:12px;",
  "--radius-panel:10px;--radius-control:6px;--radius-pill:999px}",
  "*{box-sizing:border-box}body{margin:0;background:var(--color-page);color:var(--color-text);font-family:var(--font-interface);font-size:14px}",
  ".shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}",
  ".sidebar{background:var(--color-surface);border-right:1px solid var(--color-border);padding:var(--space-gutter)}",
  ".brand{font-weight:700;margin-bottom:20px}.brand small{display:block;color:var(--color-text-muted);font-size:12px;font-weight:400}",
  ".nav{display:flex;flex-direction:column;gap:4px}.nav-link{color:var(--color-text);text-decoration:none;padding:8px 10px;border-radius:var(--radius-control)}.nav-link[aria-current=page]{background:#e9f1f8;color:var(--color-action);font-weight:550}",
  "main{padding:var(--space-gutter)}",
  ".page-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}.page-head h1{font-size:26px;margin:0 0 6px}.page-head p{margin:0;color:var(--color-text-muted)}",
  ".toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:20px}.toolbar div{display:flex;flex-direction:column;gap:4px}",
  "label{color:var(--color-text-muted);font-size:12px}input,select{min-height:44px;min-width:160px;padding:8px 10px;border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text)}",
  "button{min-height:44px;min-width:44px;padding:8px 16px;border-radius:var(--radius-control);border:1px solid var(--color-action);background:var(--color-action);color:#fff;font-weight:550}",
  "button.secondary{background:var(--color-surface);color:var(--color-action)}",
  ".record-split{display:grid;grid-template-columns:minmax(280px,1fr) minmax(320px,2fr);gap:20px;align-items:start}",
  ".panel{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:16px}",
  ".section-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.section-head h2{font-size:18px;margin:0}",
  ".result-list{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:12px}.result-list a{color:var(--color-text);text-decoration:none;display:block}",
  ".result-fields{list-style:none;margin:0;padding:0}",
  ".result-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline}",
  ".meta{color:var(--color-text-muted);font-size:12px}",
  "mark.hit{background:var(--color-surface-attention);color:var(--color-attention);padding:0 2px;border-radius:2px}",
  ".status{display:inline-block;padding:2px 10px;border-radius:var(--radius-pill);font-size:12px}.status.danger{background:var(--color-surface-danger);color:var(--color-danger)}.status.success{background:#eaf7f0;color:#18794e}.status.running{background:#e9f1f8;color:var(--color-action)}",
  ".row{display:flex;justify-content:space-between;gap:12px;margin-top:8px}.row a{color:var(--color-action)}",
  ".divider{border:0;border-top:1px solid var(--color-border);margin:16px 0}",
  ".log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}.log time{font-family:var(--font-numeric);color:var(--color-text-muted)}",
  ".log .step.error{background:var(--color-surface-danger);border-left:3px solid var(--color-danger);padding:6px 8px}",
  ".notice{border-radius:var(--radius-panel);padding:12px;background:var(--color-surface-attention)}.notice h2{font-size:18px;margin:0 0 6px}.notice p{margin:0}",
  ".state-links{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:0 0 12px;color:var(--color-text-muted);font-size:12px}",
  ".state-links a{display:inline-flex;align-items:center;min-height:44px;padding:0 8px;color:var(--color-action);border-radius:var(--radius-control)}",
  ".state-page{display:flex;justify-content:center;padding:40px 0}.state-card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:24px;max-width:520px}",
  ".state-card h2{font-size:18px;margin:0 0 8px}.mobile-nav{display:none}",
  "@media (max-width:760px){.shell{grid-template-columns:1fr}.sidebar{display:none}main{padding:16px}.record-split{grid-template-columns:1fr}",
  ".mobile-nav{display:flex;position:sticky;bottom:0;background:var(--color-surface);border-top:1px solid var(--color-border);justify-content:space-around;padding:8px 0}",
  ".mobile-link{padding:8px 12px;text-decoration:none;color:var(--color-text)}.mobile-link[aria-current=page]{color:var(--color-action);font-weight:550}}",
].join("");

/**
 * The browser half of the search. The server still renders the first document
 * and every state, so a page with scripting off is the same screen; this only
 * makes the search an in-place change: the previous result and record are
 * replaced by what is being searched for the moment the form is submitted, and
 * the request leaves from that frame. The frame is held for a moment because a
 * read over a local connection returns faster than a person can read anything,
 * and a notice that flashes for one frame is a notice nobody saw. A requestId
 * drops a response that arrived after a newer search, so a slow read cannot
 * restore stale content.
 */
const RECORDS_CLIENT_SCRIPT = [
  "(function () {",
  "  var view = document.getElementById('records-view');",
  "  if (!view) return;",
  "  var MIN_LOADING_MS = 150;",
  "  var requestId = 0;",
  "  function rangeLabel(value) {",
  "    if (value === '7d') return '最近 7 天';",
  "    if (value === 'all') return '全部时间';",
  "    return '最近 24 小时';",
  "  }",
  "  function escapeHtml(text) {",
  "    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "  }",
  "  function criteria(form) {",
  "    var data = new FormData(form);",
  "    return { keyword: String(data.get('keyword') || ''), role: String(data.get('role') || ''), range: String(data.get('range') || '24h') };",
  "  }",
  "  function params(c) {",
  "    var search = new URLSearchParams();",
  "    search.set('keyword', c.keyword);",
  "    if (c.role) search.set('role', c.role);",
  "    search.set('range', c.range);",
  "    return search;",
  "  }",
  "  function scope(c) {",
  "    var label = rangeLabel(c.range);",
  "    return c.keyword ? label + '内包含“' + escapeHtml(c.keyword) + '”的工作记录' : label + '内全部角色的工作记录';",
  "  }",
  "  function loadingHtml(c) {",
  "    return '<section class=\"state-page\" aria-live=\"polite\"><div class=\"state-card\" role=\"status\">'",
  "      + '<h2>正在读取' + scope(c) + '</h2>'",
  "      + '<p>请稍候。上一次范围的结果不会冒充本次结果。</p>'",
  "      + '</div></section>';",
  "  }",
  "  function failedHtml(c) {",
  "    return '<section class=\"state-page\"><form class=\"state-card record-search\" method=\"get\" action=\"/records\">'",
  "      + '<input type=\"hidden\" name=\"keyword\" value=\"' + escapeHtml(c.keyword) + '\">'",
  "      + '<input type=\"hidden\" name=\"role\" value=\"' + escapeHtml(c.role) + '\">'",
  "      + '<input type=\"hidden\" name=\"range\" value=\"' + escapeHtml(c.range) + '\">'",
  "      + '<h2>无法读取工作记录</h2>'",
  "      + '<p>工作记录暂时无法取得。当前条件已保留，检查内网连接后可以直接重新读取。</p>'",
  "      + '<button type=\"submit\">重新读取</button></form></section>';",
  "  }",
  "  function later(html, started) {",
  "    return { html: html, wait: Math.max(0, MIN_LOADING_MS - (Date.now() - started)) };",
  "  }",
  "  function run(event) {",
  "    var form = event.target;",
  "    if (!form || !form.classList || !form.classList.contains('record-search')) return;",
  "    event.preventDefault();",
  "    var id = ++requestId;",
  "    var c = criteria(form);",
  "    var search = params(c);",
  "    var started = Date.now();",
  "    view.innerHTML = loadingHtml(c);",
  "    try { history.replaceState(null, '', '/records?' + search.toString()); } catch { /* history is optional; the search still runs */ }",
  "    fetch('/records?' + search.toString(), { headers: { 'X-Records-View': 'fragment' } })",
  "      .then(function (response) {",
  "        if (!response.ok) throw new Error('the work records could not be read');",
  "        return response.text();",
  "      })",
  "      .then(function (html) {",
  "        var next = new DOMParser().parseFromString(html, 'text/html').getElementById('records-view');",
  "        if (!next) throw new Error('the next view is missing');",
  "        return later(next.innerHTML, started);",
  "      })",
  "      .catch(function () { return later(failedHtml(c), started); })",
  "      .then(function (outcome) {",
  "        if (id !== requestId) return;",
  "        setTimeout(function () {",
  "          if (id !== requestId) return;",
  "          view.innerHTML = outcome.html;",
  "        }, outcome.wait);",
  "      });",
  "  }",
  "  function searchOf(control) {",
  "    var form = control && control.form;",
  "    return form && form.classList && form.classList.contains('record-search') ? form : null;",
  "  }",
  "  document.addEventListener('submit', run);",
  "  // A filter that changed narrows the search the way the button does, so the",
  "  // three controls do not each need their own submit.",
  "  document.addEventListener('change', function (event) {",
  "    var form = searchOf(event.target);",
  "    if (form) run({ target: form, preventDefault: function () {} });",
  "  });",
  "  document.addEventListener('click', function (event) {",
  "    var target = event.target;",
  "    if (!target || !target.classList || !target.classList.contains('secondary')) return;",
  "    var input = document.getElementById('log-query');",
  "    if (input) input.focus();",
  "  });",
  "})();",
].join("\n");

/**
 * The complete work-records document. Every state renders the same search
 * criteria so a person never loses what they typed, and the state card is the
 * only place a result ever appears: a loading, empty or failed read shows no
 * leftover list or record.
 */
export function renderWorkRecordsPage(state: WorkRecordSearchState): string {
  const query = currentQuery(state);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>工作记录排查｜Hivemind</title><style>${RECORDS_PAGE_STYLE}</style></head><body>`
    + `<div class="shell"><aside class="sidebar"><div class="brand">Hivemind<small>内网运行控制台</small></div>`
    + `<nav class="nav" aria-label="主要导航">`
    + `<a class="nav-link" href="/">运行总览</a>`
    + `<a class="nav-link" href="/costs">费用分析</a>`
    + `<a class="nav-link" href="/roles">角色配置</a>`
    + `<a class="nav-link" aria-current="page" href="/records">工作记录</a>`
    + `</nav><div class="network-note">家庭网络 · 已连接</div></aside>`
    + `<main><header class="page-head"><div><h1>工作记录排查</h1>`
    + `<p>无需进入需求详情，直接搜索完整智能体记录并查看问题前后文。</p></div></header>`
    + renderStateLinks(query)
    + renderSearchForm(query)
    + `<div id="records-view">${renderState(state)}</div>`
    + `</main></div>`
    + `<nav class="mobile-nav" aria-label="手机导航">`
    + `<a class="mobile-link" href="/">总览</a>`
    + `<a class="mobile-link" href="/costs">费用</a>`
    + `<a class="mobile-link" href="/roles">配置</a>`
    + `<a class="mobile-link" aria-current="page" href="/records">记录</a></nav>`
    + `<script>${RECORDS_CLIENT_SCRIPT}</script>`
    + `</body></html>`;
}

/**
 * The half-open window a person's range choice means at this instant.
 *
 * The choice is a label, never an absolute pair of instants: the same page
 * describes a different window an hour later, which is what keeps 最近 24 小时
 * meaning the last 24 hours rather than the ones it was opened in.
 */
export function workRecordRange(
  range: string | undefined,
  now: number,
): { fromInclusive: number; toExclusive: number } {
  switch (range) {
    case "7d": return { fromInclusive: now - 7 * DAY_MS, toExclusive: now };
    case "all": return { fromInclusive: 0, toExclusive: now };
    default: return { fromInclusive: now - DAY_MS, toExclusive: now };
  }
}

function failureState(
  request: WorkRecordSearchRequest,
  cause: unknown,
): Extract<WorkRecordSearchState, { kind: "failed" }> {
  const body = failureBody(cause);
  return { kind: "failed", request, code: body.code, retryable: body.retryable };
}

async function readOrNull(reader: WorkRecordReader, runId: string): Promise<WorkRecordDetail | null> {
  try {
    return (await reader.read({ runId })).record;
  } catch {
    // A record that cannot be read leaves the list standing; the list is still
    // the answer to the search that was asked.
    return null;
  }
}

/** The runId of the first match whose work has not stopped, or null. */
async function firstRunning(
  reader: WorkRecordReader,
  matches: readonly WorkRecordSearchResult["matches"][number][],
): Promise<string | null> {
  for (const match of matches) {
    const record = await readOrNull(reader, match.runId);
    if (record !== null && record.status.kind === "running") return record.runId;
  }
  return null;
}

/** The runId the page opens on: the one asked for, else work still going, else newest. */
async function initialRunId(
  reader: WorkRecordReader,
  matches: readonly WorkRecordSearchResult["matches"][number][],
  wanted?: string,
): Promise<string | undefined> {
  if (wanted !== undefined && matches.some((match) => match.runId === wanted)) return wanted;
  // A work that has not stopped is the one a person can still act on, and it is
  // what the waiting state describes; which match happens to be newest moves
  // with the clock, so leaving it to the sort would show the wait only at some
  // hours of the day.
  return (await firstRunning(reader, matches)) ?? matches[0]?.runId;
}

/**
 * Builds the screen state for one `/records` request.
 *
 * `state=empty|loading|error|waiting` names a state on its own URL, which is
 * how the interface contract makes all four reachable without inventing data.
 * Without it the page is the search itself: newest match first, one run
 * selected so the record is on screen beside the list.
 */
export async function loadWorkRecordScreen(
  reader: WorkRecordReader,
  raw: WorkRecordsRouteParameters,
  now: number,
): Promise<WorkRecordSearchState> {
  const keyword = raw.keyword ?? WORK_RECORD_BROWSE_DEFAULTS.keyword;
  const role = raw.role === undefined || raw.role === "" || raw.role === WORK_RECORD_BROWSE_DEFAULTS.role
    ? undefined
    : raw.role;
  const query: WorkRecordSearchQuery = {
    keyword,
    ...(role === undefined ? {} : { role }),
    ...workRecordRange(raw.range ?? WORK_RECORD_BROWSE_DEFAULTS.range, now),
  };
  const request: WorkRecordSearchRequest = { requestId: "records", query };
  if (raw.state === "loading") return { kind: "loading", request };
  if (raw.state === "empty") return { kind: "empty", request };
  if (raw.state === "error") return { kind: "failed", request, code: "unavailable", retryable: true };

  let result: WorkRecordSearchResult;
  try {
    result = await reader.search(query);
  } catch (cause) {
    return failureState(request, cause);
  }
  if (result.matches.length === 0) return { kind: "empty", request };

  const runId = await initialRunId(reader, result.matches, raw.runId);
  const record = runId === undefined ? null : await readOrNull(reader, runId);
  if (record === null) return { kind: "ready", request, result, selection: { kind: "none" } };
  return {
    kind: "ready",
    request,
    result,
    selection: { kind: "ready", runId: record.runId, requestId: request.requestId, record },
  };
}

/** The complete `/records` document for one request. */
export async function renderWorkRecordsRoute(
  reader: WorkRecordReader,
  raw: WorkRecordsRouteParameters,
  now: number,
): Promise<string> {
  return renderWorkRecordsPage(await loadWorkRecordScreen(reader, raw, now));
}
