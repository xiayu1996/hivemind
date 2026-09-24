import {
  listDailyCostTimeZones,
  type DailyCostReadResult,
  type DailyCostSelection,
  type DailyCostSnapshot,
  type DailyCostTimeZoneOption,
} from "./daily-costs.js";
import type { RequirementCostWithLimitSnapshot } from "../persistence/requirement-cost-limit.js";
import { presentRequirementCostLimit, type RequirementCostLimitPageView } from "./requirement-cost-limit.js";
import { formatDailyCostScope, formatUsd, renderDailyCostPanel, type DailyCostViewSnapshot } from "../../console-ui/src/costs/contracts.js";
import { COSTS_PAGE_STYLE } from "../../console-ui/src/costs/page-style.js";
import { renderRequirementCostSection } from "./requirement-cost-view.js";

/**
 * The costs page, rendered on the server that holds the central ledger.
 *
 * It is server-rendered rather than a client bundle so the screen a person is
 * judged on exists the moment the console answers: a page that only appears
 * after a build is a page missing on the machine that has the data. The
 * selection travels in the query string, so a state a person reached is a URL
 * they can reopen, and every state the scenario declares is reachable on its
 * own (`?state=empty|loading|error|waiting`), the way the repository's
 * interface contract already describes its pages.
 */
export type CostsPageState = "ready" | "empty" | "loading" | "error" | "waiting";

const FORCED_STATES: ReadonlySet<CostsPageState> = new Set(["empty", "loading", "error", "waiting"]);

interface RangeOption {
  value: string;
  label: string;
}

const PRESET_RANGES: readonly RangeOption[] = [
  { value: "all", label: "全部时间" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
];

/** A range the person selected by its two local dates, e.g. `2025-06-20|2025-06-21`. */
const EXPLICIT_RANGE = /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})$/;

/** The whole ledger. `all` means no day is outside the range, not a guessed start. */
const ALL_TIME_START = "1970-01-01";
const ALL_TIME_END = "9999-12-31";

const DAY_MS = 86_400_000;

export interface CostsPageRequest {
  selection: DailyCostSelection;
  rangeValue: string;
  rangeLabel: string;
  forcedState: CostsPageState | null;
  /** The requirement the page is scoped to, when a person came from one. */
  requirementId: string | null;
  /** Whether the page was reached by saving a requirement limit just now. */
  limitSaved: boolean;
}

export interface CostsPageView {
  state: CostsPageState;
  selection: DailyCostSelection;
  rangeValue: string;
  rangeLabel: string;
  zones: readonly DailyCostTimeZoneOption[];
  snapshot?: DailyCostViewSnapshot;
  requirementId: string | null;
  /** The requirement's whole-history cost and configured limit, when the page
   * was scoped to one. */
  requirement?: RequirementCostWithLimitSnapshot;
  limitSaved: boolean;
}

/** The page's view of a ledger snapshot: the same days under the scope they are read in. */
function viewSnapshot(snapshot: DailyCostSnapshot): DailyCostViewSnapshot {
  return {
    selection: snapshot.selection,
    scope: formatDailyCostScope(snapshot.selection.timeZone),
    days: snapshot.days,
    totalUsd: snapshot.totalUsd,
    pendingBilling: snapshot.pendingBilling,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function presetRange(value: string, now: number): { startDate: string; endDate: string; label: string } {
  if (value === "7d") {
    return { startDate: isoDate(now - 6 * DAY_MS), endDate: isoDate(now), label: "最近 7 天" };
  }
  if (value === "30d") {
    return { startDate: isoDate(now - 29 * DAY_MS), endDate: isoDate(now), label: "最近 30 天" };
  }
  return { startDate: ALL_TIME_START, endDate: ALL_TIME_END, label: "全部时间" };
}

/**
 * Turns the query a person submitted into the range and zone the page shows.
 * An explicit pair of dates wins over a preset, and a range submitted as
 * `start|end` (how the date combobox carries a custom range) is explicit too.
 * An unknown zone falls back to the default rather than reading nothing.
 */
export function resolveCostsPageRequest(
  query: Readonly<Record<string, string | undefined>>,
  zoneIds: ReadonlySet<string>,
  now: number = Date.now(),
): CostsPageRequest {
  const explicitDates = query.startDate !== undefined && query.startDate !== "" && query.endDate !== undefined && query.endDate !== ""
    ? { start: query.startDate, end: query.endDate }
    : null;
  const fromRange = query.range === undefined ? null : EXPLICIT_RANGE.exec(query.range);
  let startDate: string;
  let endDate: string;
  let rangeValue: string;
  let rangeLabel: string;
  if (explicitDates) {
    ({ start: startDate, end: endDate } = explicitDates);
    rangeValue = `${startDate}|${endDate}`;
    rangeLabel = `${startDate} 至 ${endDate}`;
  } else if (fromRange) {
    startDate = fromRange[1]!;
    endDate = fromRange[2]!;
    rangeValue = `${startDate}|${endDate}`;
    rangeLabel = `${startDate} 至 ${endDate}`;
  } else {
    const presetValue = PRESET_RANGES.some((option) => option.value === query.range) ? query.range! : "all";
    const preset = presetRange(presetValue, now);
    startDate = preset.startDate;
    endDate = preset.endDate;
    rangeValue = presetValue;
    rangeLabel = preset.label;
  }

  const requestedZone = query.timeZone;
  const timeZone = requestedZone !== undefined && zoneIds.has(requestedZone)
    ? requestedZone
    : zoneIds.has("Asia/Shanghai") ? "Asia/Shanghai" : zoneIds.values().next().value ?? "UTC";

  const forcedState = query.state !== undefined && FORCED_STATES.has(query.state as CostsPageState)
    ? query.state as CostsPageState
    : null;

  const requirement = query.requirement?.trim();

  return {
    selection: { timeZone, startDate, endDate },
    rangeValue,
    rangeLabel,
    forcedState,
    requirementId: requirement === undefined || requirement === "" ? null : requirement,
    limitSaved: query.limitSaved === "1",
  };
}

/** Reads the range and settles which of the five states the page is in. */
export async function loadCostsPage(
  query: Readonly<Record<string, string | undefined>>,
  zones: readonly DailyCostTimeZoneOption[],
  read: (selection: DailyCostSelection) => Promise<DailyCostReadResult>,
  now: number = Date.now(),
  requirementRead?: (requirementId: string) => Promise<RequirementCostWithLimitSnapshot | null>,
): Promise<CostsPageView> {
  const request = resolveCostsPageRequest(query, new Set(zones.map((zone) => zone.id)), now);
  // A requirement the person came from is read whatever the daily band's own
  // state is: the cumulative figure is a different question from the day view,
  // and an empty day range must not hide it.
  const requirement = request.requirementId !== null && requirementRead
    ? (await requirementRead(request.requirementId)) ?? undefined
    : undefined;
  const base = {
    selection: request.selection,
    rangeValue: request.rangeValue,
    rangeLabel: request.rangeLabel,
    zones,
    requirementId: request.requirementId,
    limitSaved: request.limitSaved,
    ...(requirement === undefined ? {} : { requirement }),
  };
  const forced = request.forcedState;
  // A state a person asked to see is not read from the ledger: loading and
  // failure are exactly the cases where there is nothing to read, and an empty
  // request that came back with rows would be a different state.
  if (forced === "empty" || forced === "loading" || forced === "error") {
    return { ...base, state: forced };
  }
  const result = await read(request.selection);
  if (forced === "waiting") {
    return result.kind === "ok"
      ? { ...base, state: "waiting", snapshot: viewSnapshot(result.snapshot) }
      : { ...base, state: "waiting" };
  }
  if (result.kind !== "ok") return { ...base, state: "error" };
  if (result.snapshot.days.length === 0) return { ...base, state: "empty" };
  if (result.snapshot.pendingBilling === "pending_latest_usage") {
    return { ...base, state: "waiting", snapshot: viewSnapshot(result.snapshot) };
  }
  return { ...base, state: "ready", snapshot: viewSnapshot(result.snapshot) };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface NavigationLink {
  label: string;
  href: string;
  current?: boolean;
}

const DESKTOP_NAV: readonly NavigationLink[] = [
  { label: "运行总览", href: "/" },
  { label: "费用分析", href: "/costs", current: true },
  { label: "角色配置", href: "/roles" },
  { label: "工作记录", href: "/records" },
];

const MOBILE_NAV: readonly NavigationLink[] = [
  { label: "总览", href: "/" },
  { label: "费用", href: "/costs", current: true },
  { label: "配置", href: "/roles" },
  { label: "记录", href: "/records" },
];

function renderNavigation(links: readonly NavigationLink[], className: string, label: string): string {
  return `<nav class="${className}" aria-label="${escapeHtml(label)}">`
    + links.map((link) => `<a class="${className === "nav" ? "nav-link" : "mobile-link"}" href="${escapeHtml(link.href)}"`
      + `${link.current === true ? ' aria-current="page"' : ""}>${escapeHtml(link.label)}</a>`).join("")
    + `</nav>`;
}

function renderSidebar(): string {
  return `<aside class="sidebar"><div class="brand">Hivemind<small>内网运行控制台</small></div>`
    + renderNavigation(DESKTOP_NAV, "nav", "主要导航")
    + `<div class="network-note">家庭网络 · 已连接</div></aside>`;
}

function renderToolbar(view: CostsPageView): string {
  const ranges = [...PRESET_RANGES];
  if (!ranges.some((option) => option.value === view.rangeValue)) {
    ranges.push({ value: view.rangeValue, label: view.rangeLabel });
  }
  const rangeOptions = ranges.map((option) =>
    `<option value="${escapeHtml(option.value)}"${option.value === view.rangeValue ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
  ).join("");
  const zoneOptions = view.zones.map((zone) =>
    `<option value="${escapeHtml(zone.id)}"${zone.id === view.selection.timeZone ? " selected" : ""}>${escapeHtml(zone.label)}</option>`,
  ).join("");
  return `<form class="toolbar" method="get" action="/costs">`
    + `<div><label for="cost-range">日期范围</label><select id="cost-range" name="range">${rangeOptions}</select></div>`
    + `<div><label for="cost-timezone">自然日时区</label><select id="cost-timezone" name="timeZone">${zoneOptions}</select></div>`
    + `<button type="submit">查看费用</button></form>`;
}

function renderPageHead(withRefresh: boolean): string {
  return `<header class="page-head"><div><h1>费用分析</h1>`
    + `<p>历史费用按使用发生时的官方价格固化，供应商之后调价不会改变这里的金额。</p></div>`
    + (withRefresh ? `<div class="refresh">刚刚更新</div>` : "")
    + `</header>`;
}

function renderReadyBody(view: CostsPageView): string {
  const snapshot: DailyCostViewSnapshot = view.snapshot ?? {
    selection: view.selection,
    scope: formatDailyCostScope(view.selection.timeZone),
    days: [],
    totalUsd: 0,
    pendingBilling: "settled",
  };
  return renderPageHead(true)
    + renderToolbar(view)
    + `<div class="metric-grid"><div class="metric"><div class="metric-name">所选范围累计费用</div>`
    + `<span class="metric-value">${escapeHtml(formatUsd(snapshot.totalUsd))}</span>`
    + `<div class="metric-detail">${escapeHtml(snapshot.scope)}</div></div></div>`
    + `<div class="split section">${renderDailyCostPanel(snapshot)}`
    + `<aside class="panel"><h2>计费口径</h2>`
    + `<p>所有供应商的使用统一按发生时官方按量价格折算为美元；订阅制模型也按同样口径展示。</p>`
    + `<ul><li>输入、输出与缓存命中分别计价</li><li>每次使用保留当时价格版本</li><li>历史金额只汇总，不按新价格重算</li></ul>`
    + `</aside></div>`;
}

function renderEmptyBody(view: CostsPageView): string {
  return `<header class="page-head"><div><h1>费用分析</h1><p>按自然日与所选时区查看美元费用。</p></div></header>`
    + renderToolbar(view)
    + `<div class="state-page"><div class="state-card"><h2>所选范围还没有费用</h2>`
    + `<p>调整日期或需求范围；模型开始产生使用后，这里会按所选时区的自然日汇总。</p>`
    + `<div class="actions"><form method="get" action="/costs"><button type="submit">调整筛选条件</button></form></div>`
    + `</div></div>`;
}

function renderLoadingBody(view: CostsPageView): string {
  return `<header class="page-head"><div><h1>费用分析</h1></div></header>`
    + `<div class="state-page"><div class="state-card" aria-live="polite"><div class="spinner" aria-hidden="true"></div>`
    + `<h2>正在汇总费用</h2>`
    + `<p>正在按 ${escapeHtml(view.selection.timeZone)} 自然日汇总历史使用、价格版本和美元金额，请稍候。</p>`
    + `</div></div>`;
}

function renderErrorBody(view: CostsPageView): string {
  return `<header class="page-head"><div><h1>费用分析</h1></div></header>`
    + `<div class="state-page"><div class="state-card"><h2>无法读取费用记录</h2>`
    + `<p>所选范围的使用与价格记录没有载入。检查内网连接后重新读取，历史金额不会重新计算。</p>`
    + `<div class="actions"><form method="get" action="/costs">`
    + `<input type="hidden" name="timeZone" value="${escapeHtml(view.selection.timeZone)}">`
    + `<input type="hidden" name="range" value="${escapeHtml(view.rangeValue)}">`
    + `<button type="submit">重新读取</button></form></div></div></div>`;
}

function renderWaitingBody(view: CostsPageView): string {
  return `<header class="page-head"><div><h1>费用分析</h1></div></header>`
    + `<div class="state-page"><div class="state-card"><h2>正在等待最新使用完成计费</h2>`
    + `<p>最近一次模型使用尚未形成费用记录；页面会自动刷新，已有历史金额保持不变。</p>`
    + `<div class="actions"><a class="button secondary" href="/">查看当前轮</a></div></div></div>`
    + (view.snapshot ? `<div class="section">${renderDailyCostPanel(view.snapshot)}</div>` : "");
}

/** The complete document for one state. Only the current state is in the tree. */
export function renderCostsPage(view: CostsPageView): string {
  const body = view.state === "loading" ? renderLoadingBody(view)
    : view.state === "error" ? renderErrorBody(view)
      : view.state === "empty" ? renderEmptyBody(view)
        : view.state === "waiting" ? renderWaitingBody(view)
          : renderReadyBody(view);
  // A requirement-scoped visit keeps the whole-history breakdown visible under
  // every daily state: the day range answering "nothing here" says nothing
  // about whether the requirement itself has recorded usage. The limit panel is
  // read from the same snapshot, so the figure and the alert cannot disagree.
  const requirement = view.requirement === undefined
    ? ""
    : `<div class="section">${renderRequirementCostSection(view.requirement.cost, {
      locale: "zh-CN",
      timeZone: view.selection.timeZone,
    })}${renderRequirementLimitPanel(
      presentRequirementCostLimit(view.requirement, view.limitSaved ? "saved" : "none"),
    )}</div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>费用分析｜Hivemind</title><style>${COSTS_PAGE_STYLE}</style></head><body>`
    + `<div class="shell">${renderSidebar()}<main>${body}${requirement}</main></div>`
    + renderNavigation(MOBILE_NAV, "mobile-nav", "手机导航")
    + `</body></html>`;
}

/** A requirement's cumulative figure and configured limit, with the save form. */
function renderRequirementLimitPanel(limit: RequirementCostLimitPageView): string {
  const metric = limit.metric;
  const limitText = metric.configuredLimit ?? "未设置";
  const statusLine = metric.continuationText === null
    ? escapeHtml(metric.statusText)
    : `${escapeHtml(metric.statusText)}，${escapeHtml(metric.continuationText)}`;
  const confirmation = limit.form.confirmationText === null
    ? ""
    : `<p class="metric-detail" role="status">${escapeHtml(limit.form.confirmationText)}</p>`;
  return `<section class="panel section" aria-labelledby="requirement-limit-title">`
    + `<div class="section-head"><div><h2 id="requirement-limit-title">需求费用上限</h2>`
    + `<p class="metric-detail">全部轮次累计费用 <span class="money">${escapeHtml(metric.cumulativeAmount)}</span> `
    + `<a href="/requirements/${encodeURIComponent(limit.form.requirementId)}">查看需求详情</a></p></div></div>`
    + `<div class="metric${metric.status === "over_limit" ? " danger" : ""}">`
    + `<span class="metric-name">需求费用上限</span><br>`
    + `<span class="metric-value money">${escapeHtml(limitText)}</span>`
    + `<div class="metric-detail" role="status">${statusLine}</div></div>`
    + `<form method="post" action="/costs/requirement-limit">`
    + `<input type="hidden" name="requirementId" value="${escapeHtml(limit.form.requirementId)}">`
    + `<input type="hidden" name="expectedVersion" value="${limit.form.version === null ? "" : String(limit.form.version)}">`
    + `<div><label for="requirement-limit-input">需求费用上限</label>`
    + `<input id="requirement-limit-input" name="limitUsd" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(limit.form.currentLimit ?? "")}"></div>`
    + `<button type="submit">保存上限</button></form>`
    + confirmation
    + `</section>`;
}

/** Reads one request and renders it: what the console route hands back. */
export async function renderCostsRoute(
  query: Readonly<Record<string, string | undefined>>,
  zones: readonly DailyCostTimeZoneOption[],
  read: (selection: DailyCostSelection) => Promise<DailyCostReadResult>,
  now: number = Date.now(),
  requirementRead?: (requirementId: string) => Promise<RequirementCostWithLimitSnapshot | null>,
): Promise<string> {
  return renderCostsPage(await loadCostsPage(query, zones, read, now, requirementRead));
}

/** The zone catalog, from the source when it can enumerate one, from the runtime otherwise. */
export async function costsPageZones(
  source: { dailyCostTimeZones?: () => Promise<readonly DailyCostTimeZoneOption[]> },
): Promise<readonly DailyCostTimeZoneOption[]> {
  if (source.dailyCostTimeZones) return source.dailyCostTimeZones();
  return listDailyCostTimeZones();
}
