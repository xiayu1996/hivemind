/**
 * The mobile console's cost, record and role screens.
 *
 * They are rendered by the process that holds the central store rather than by
 * a client bundle: a screen that only exists after somebody ran a build is a
 * screen missing on the machine that needs it. Every colour, size and radius
 * below is a value from the interface contract's token table, because the
 * contract layer measures the delivered screens against it.
 *
 * The four page states (empty, loading, error, waiting) are reachable from the
 * query string (`?state=`), which is what lets a round look at each of them on
 * its own URL without inventing data.
 *
 * Nothing here reads a clock or a file: the caller supplies the read ports and
 * the redraw instant, so the same input renders the same document.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  transitionConsoleLoadState,
  type ConsoleAccessDecision,
  type ConsoleAccessPolicy,
  type ConsoleCostPort,
  type ConsoleLoadState,
  type ConsoleReadFailure,
  type ConsoleRoleConfigurationPort,
  type ConsoleWorkRecordPort,
  type CostQuery,
  type CostSnapshot,
  type IsoInstant,
  type RoleChangePreview,
  type RoleConfiguration,
  type RoleConfigurationDifference,
  type RoleConfigurationView,
  type RoleMutationResult,
  type WorkRecordDetail,
  type WorkRecordQuery,
  type WorkRecordSearchPage,
} from "./operator-contract.js";

// ---------------------------------------------------------------------------
// Styles. Every named colour, size, radius and gap is a token value.
// ---------------------------------------------------------------------------

const STYLES = [
  ":root{--color-page:#f4f7fa;--color-surface:#ffffff;--color-text:#172b3a;--color-text-muted:#526477;--color-border:#cbd5df;--color-action:#173f63;--color-attention:#a75b00;--color-danger:#b42318;--color-success:#18794e;--color-focus:#0b6bcb;--color-surface-attention:#fff4df;--color-surface-danger:#fff0ef;--color-surface-success:#eaf7f0;--color-surface-selected:#e9f1f8;",
  "--space-inline-tight:4px;--space-control-gap:8px;--space-content-gap:12px;--space-section-gap:20px;--space-page-gutter:28px;--space-page-gutter-mobile:16px;",
  "--font-interface:\"IBM Plex Sans\",\"Segoe UI\",sans-serif;--font-numeric:\"IBM Plex Mono\",\"SFMono-Regular\",monospace;",
  "--font-caption:12px;--font-body:14px;--font-body-large:16px;--font-heading-small:18px;--font-heading-page:26px;--font-metric:30px;",
  "--weight-regular:400;--weight-medium:550;--weight-strong:700;--radius-control:6px;--radius-panel:10px;--radius-pill:999px;--shadow-raised:0 2px 8px #172b3a14;--layer-sticky:10;--layer-navigation:20}",
  "*,*::before,*::after{box-sizing:border-box}",
  "*{margin:0;padding:0}",
  "html{background-color:var(--color-page);color:var(--color-text);font-family:var(--font-interface);font-size:var(--font-body);line-height:1.5}",
  "body{min-width:320px}",
  "a{color:var(--color-action)}",
  "a[href]{display:inline-flex;align-items:center;min-width:44px;min-height:44px}",
  "button,input,select,textarea{font:inherit;color:inherit}",
  "button,.button,.nav-link,.mobile-link{min-height:44px;min-width:44px}",
  "button,.button{border:1px solid var(--color-action);border-radius:var(--radius-control);background-color:var(--color-action);color:var(--color-surface);font-weight:var(--weight-medium);padding:12px 20px;display:inline-flex;align-items:center;justify-content:center;gap:var(--space-control-gap);text-decoration:none}",
  "button.secondary,.button.secondary{background-color:var(--color-surface);color:var(--color-action);border-color:var(--color-border)}",
  ":focus-visible{outline:3px solid var(--color-focus);outline-offset:2px}",
  "input,select,textarea{width:100%;min-height:44px;border:1px solid var(--color-border);border-radius:var(--radius-control);background-color:var(--color-surface);padding:11px 12px}",
  "textarea{min-height:160px;line-height:1.55}",
  "label,.field-label{display:block;font-weight:var(--weight-medium);margin-bottom:var(--space-inline-tight)}",
  "select{appearance:none;-webkit-appearance:none;padding-right:40px;background-image:linear-gradient(45deg,transparent 50%,var(--color-text-muted) 50%),linear-gradient(135deg,var(--color-text-muted) 50%,transparent 50%);background-position:calc(100% - 18px) 20px,calc(100% - 13px) 20px;background-size:5px 5px;background-repeat:no-repeat;cursor:pointer}",
  ".shell{display:grid;grid-template-columns:224px minmax(0,1fr);min-height:100vh}",
  ".sidebar{position:sticky;top:0;height:100vh;background-color:var(--color-surface);border-right:1px solid var(--color-border);padding:20px 16px;z-index:var(--layer-sticky)}",
  ".brand{font-size:var(--font-heading-small);font-weight:var(--weight-strong);padding:0 12px 16px}",
  ".brand small{display:block;color:var(--color-text-muted);font-size:var(--font-caption);font-weight:var(--weight-regular);margin-top:4px}",
  ".nav{display:grid;gap:var(--space-inline-tight)}",
  ".nav-link{display:flex;align-items:center;padding:12px;border-radius:var(--radius-control);text-decoration:none;color:var(--color-text);font-weight:var(--weight-medium)}",
  ".nav-link[aria-current=\"page\"]{background-color:var(--color-surface-selected);color:var(--color-action)}",
  "main{min-width:0;padding:20px var(--space-page-gutter) 28px;max-width:1440px;width:100%;margin:0 auto}",
  ".page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-section-gap);margin-bottom:20px}",
  ".page-head h1{font-size:var(--font-heading-page);line-height:1.2;margin-bottom:4px}",
  ".page-head p{color:var(--color-text-muted);max-width:76ch}",
  ".refresh{font-size:var(--font-caption);color:var(--color-text-muted);white-space:nowrap}",
  "h1,h2,h3{margin:0}",
  "h2{font-size:var(--font-heading-small)}",
  "h3{font-size:var(--font-body-large)}",
  ".section{margin-top:var(--space-section-gap)}",
  ".section-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-content-gap);margin-bottom:10px}",
  ".section-head p,.section-head .meta{color:var(--color-text-muted);font-size:var(--font-caption)}",
  ".panel{background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:18px}",
  ".panel.flush{padding:0;overflow:hidden}",
  ".panel + .panel{margin-top:var(--space-content-gap)}",
  ".split{display:grid;grid-template-columns:minmax(0,2fr) minmax(270px,1fr);gap:var(--space-section-gap);align-items:start}",
  ".status{display:inline-flex;align-items:center;min-height:26px;border-radius:var(--radius-pill);padding:4px 8px;font-size:var(--font-caption);font-weight:var(--weight-strong);white-space:nowrap;background-color:var(--color-surface-selected);color:var(--color-action)}",
  ".status.attention{background-color:var(--color-surface-attention);color:var(--color-attention)}",
  ".status.danger{background-color:var(--color-surface-danger);color:var(--color-danger)}",
  ".status.success{background-color:var(--color-surface-success);color:var(--color-success)}",
  ".meta{color:var(--color-text-muted);font-size:var(--font-caption)}",
  ".metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-content-gap)}",
  ".metric{padding:16px;background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel)}",
  ".metric-name{color:var(--color-text-muted);font-size:var(--font-caption)}",
  ".metric-value{font-family:var(--font-numeric);font-size:var(--font-metric);font-weight:var(--weight-strong);line-height:1.2;margin-top:4px}",
  ".metric-detail{font-size:var(--font-caption);margin-top:4px}",
  ".money,.number{font-family:var(--font-numeric);font-variant-numeric:tabular-nums}",
  ".row{display:flex;gap:var(--space-content-gap);align-items:baseline;justify-content:space-between}",
  ".stack{display:grid;gap:var(--space-content-gap);list-style:none}",
  ".actions{display:flex;gap:var(--space-control-gap);flex-wrap:wrap;align-items:center}",
  ".divider{border:0;border-top:1px solid var(--color-border);margin:16px 0}",
  ".toolbar{display:grid;grid-template-columns:repeat(3,minmax(140px,1fr));gap:var(--space-content-gap);align-items:end;margin-bottom:var(--space-section-gap)}",
  ".toolbar .wide{grid-column:span 2}",
  ".notice{border:1px solid var(--color-border);border-left:4px solid var(--color-action);border-radius:var(--radius-control);padding:12px 16px;background-color:var(--color-surface)}",
  ".notice.attention{border-left-color:var(--color-attention);background-color:var(--color-surface-attention)}",
  ".notice.danger{border-left-color:var(--color-danger);background-color:var(--color-surface-danger)}",
  ".notice.success{border-left-color:var(--color-success);background-color:var(--color-surface-success)}",
  ".notice h2{font-size:var(--font-heading-small);margin-bottom:4px}",
  ".state-page{min-height:58vh;display:flex;align-items:center;justify-content:center}",
  ".state-card{width:min(560px,100%);padding:28px;background-color:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel)}",
  ".state-card h2{font-size:var(--font-heading-page);margin-bottom:8px}",
  ".state-card p{color:var(--color-text-muted);font-size:var(--font-body-large)}",
  ".state-card .actions{margin-top:16px}",
  ".cost-row{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--space-content-gap);padding:12px 0;border-top:1px solid var(--color-border)}",
  ".cost-row:first-child{border-top:0}",
  ".mobile-nav{display:none}",
  ".reserve{display:none}",
  ".record-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:var(--space-section-gap);align-items:start}",
  ".result-list{list-style:none;display:grid;gap:var(--space-content-gap)}",
  ".result-list a{display:block;padding:12px;border:1px solid var(--color-border);border-radius:var(--radius-control);text-decoration:none;color:var(--color-text)}",
  ".result-list a[aria-current=\"true\"]{background-color:var(--color-surface-selected);border-color:var(--color-action)}",
  ".match{background-color:var(--color-surface-attention);color:var(--color-attention);font-weight:var(--weight-strong)}",
  ".record-body{white-space:pre-wrap}",
  ".neighbor{margin-top:var(--space-content-gap);padding-top:var(--space-content-gap);border-top:1px solid var(--color-border)}",
  ".diff{display:inline-flex;min-height:24px;align-items:center;border-radius:var(--radius-pill);padding:2px 8px;font-size:var(--font-caption);font-weight:var(--weight-strong)}",
  ".diff.added{background-color:var(--color-surface-success);color:var(--color-success)}",
  ".diff.removed{background-color:var(--color-surface-danger);color:var(--color-danger)}",
  ".diff.changed{background-color:var(--color-surface-attention);color:var(--color-attention)}",
  ".version-label{color:var(--color-text-muted);font-size:var(--font-caption);font-weight:var(--weight-medium)}",
  ".prompt-box{white-space:pre-wrap;border:1px solid var(--color-border);border-radius:var(--radius-control);padding:12px;background-color:var(--color-page)}",
  "@media (max-width:760px){",
  ".shell{display:block}",
  ".sidebar{display:none}",
  "main{padding:18px var(--space-page-gutter-mobile) 104px}",
  ".page-head{display:block;margin-bottom:18px}",
  ".toolbar{grid-template-columns:1fr}",
  ".toolbar .wide{grid-column:auto}",
  ".split,.record-split{grid-template-columns:1fr}",
  ".metric-grid{grid-template-columns:1fr}",
  ".cost-row{grid-template-columns:1fr 1fr}",
  ".mobile-nav{position:fixed;display:grid;grid-template-columns:repeat(4,1fr);bottom:0;left:0;right:0;background-color:var(--color-surface);border-top:1px solid var(--color-border);box-shadow:var(--shadow-raised);z-index:var(--layer-navigation);padding-bottom:max(4px,env(safe-area-inset-bottom))}",
  ".mobile-link{display:flex;align-items:center;justify-content:center;text-align:center;padding:8px 4px;color:var(--color-text);font-size:var(--font-caption);text-decoration:none}",
  ".mobile-link[aria-current=\"page\"]{color:var(--color-action);font-weight:var(--weight-strong);background-color:var(--color-surface-selected)}",
  ".reserve{display:block;height:96px}",
  "}",
  "@media (max-width:420px){.cost-row{grid-template-columns:1fr}.actions{display:grid}.actions>*{width:100%}}",
  "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}",
].join("");

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const BRAND = { name: "Hivemind", tagline: "内网运行控制台" };

const ROLE_LABELS: Record<string, string> = {
  verifier: "验证者",
  engineer: "工程师",
  prototype: "原型",
  "product-manager": "产品经理",
  reviewer: "审查者",
  coder: "编码",
};

type NavKey = "overview" | "costs" | "roles" | "records";

const NAV_ITEMS: readonly { key: NavKey; href: string; label: string; short: string }[] = [
  { key: "overview", href: "/operator/overview", label: "运行总览", short: "总览" },
  { key: "costs", href: "/operator/costs", label: "费用分析", short: "费用" },
  { key: "roles", href: "/operator/roles", label: "角色配置", short: "配置" },
  { key: "records", href: "/operator/records", label: "工作记录", short: "记录" },
];

/** Local calendar date for an instant in a zone, as `YYYY-MM-DD`. */
function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(instant);
}

/** Local date and time for an instant in a zone, as `YYYY-MM-DD HH:mm`. */
function localDateTime(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

// ---------------------------------------------------------------------------
// Markup helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function documentHtml(options: { title: string; body: string }): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>${STYLES}</style>`,
    `</head><body>${options.body}</body></html>`,
  ].join("");
}

function sidebar(current: NavKey): string {
  const links = NAV_ITEMS.map((item) =>
    `<a class="nav-link" href="${item.href}"${item.key === current ? ' aria-current="page"' : ""}>${item.label}</a>`,
  ).join("");
  return `<aside class="sidebar"><div class="brand">${BRAND.name}<small>${BRAND.tagline}</small></div>`
    + `<nav class="nav" aria-label="运行总览">${links}</nav></aside>`;
}

function mobileNav(current: NavKey): string {
  const links = NAV_ITEMS.map((item) =>
    `<a class="mobile-link" href="${item.href}"${item.key === current ? ' aria-current="page"' : ""}>${item.short}</a>`,
  ).join("");
  return `<nav class="mobile-nav" aria-label="手机导航">${links}</nav>`;
}

function shell(options: { title: string; current: NavKey; body: string }): string {
  return documentHtml({
    title: options.title,
    body: `<div class="shell">${sidebar(options.current)}<main>${options.body}`
      + '<div class="reserve" aria-hidden="true"></div></main></div>'
      + mobileNav(options.current),
  });
}

function pageHead(heading: string, intro: string, trailing = ""): string {
  return `<header class="page-head"><div><h1>${escapeHtml(heading)}</h1>`
    + (intro ? `<p>${escapeHtml(intro)}</p>` : "")
    + `</div>${trailing}</header>`;
}

function noticeBlock(options: {
  tone: "" | "attention" | "danger" | "success";
  heading: string;
  body?: string;
  bare?: string;
  action?: string;
}): string {
  const tone = options.tone === "" ? "" : ` ${options.tone}`;
  return `<div class="notice${tone} section"><h2>${escapeHtml(options.heading)}</h2>`
    + (options.body ? `<p>${escapeHtml(options.body)}</p>` : "")
    + (options.bare ? `<div class="bare"><div class="field-label">${escapeHtml(options.heading)}</div>${escapeHtml(options.bare)}</div>` : "")
    + (options.action ?? "")
    + "</div>";
}

function sendHtml(reply: FastifyReply, body: string): FastifyReply {
  return reply.code(200).type("text/html; charset=utf-8").send(body);
}

function retryForm(action: string, fields: Record<string, string>, label: string): string {
  const hidden = Object.entries(fields)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  return `<form class="actions" method="get" action="${escapeHtml(action)}">${hidden}`
    + `<button class="secondary" type="submit">${escapeHtml(label)}</button></form>`;
}

// ---------------------------------------------------------------------------
// The access screen
// ---------------------------------------------------------------------------

/**
 * The screen a device outside the allowed networks gets. It names the networks
 * that are allowed and offers the recheck; it never carries operator data or
 * the backend navigation, because the request behind it may not have been read.
 */
export function renderOperatorAccessPage(decision: ConsoleAccessDecision): string {
  if (decision.allowed) {
    return documentHtml({
      title: "访问验证｜Hivemind",
      body: '<section class="state-page"><div class="state-card">'
        + "<h2>当前设备可以进入后台</h2>"
        + `<p>当前设备在允许访问的网络内。${escapeHtml(decision.networkId)} 网络已放行。</p>`
        + '<div class="actions"><a class="button" href="/operator/costs">进入费用分析</a></div>'
        + "</div></section>",
    });
  }
  const labels = decision.allowedNetworkLabels.join("、");
  return documentHtml({
    title: "访问验证｜Hivemind",
    body: '<section class="state-page"><div class="state-card">'
      + '<span class="status danger">无法访问</span>'
      + "<h2>当前设备无法进入后台</h2>"
      + "<p>当前设备未连接允许访问的家庭或办公网络，因此不能查看任何后台内容。</p>"
      + `<div class="bare"><div class="field-label">允许的网络范围</div>${escapeHtml(labels)}</div>`
      + '<form class="actions" method="get" action="/access"><button type="submit">重新检查</button></form>'
      + "</div></section>",
  });
}

// ---------------------------------------------------------------------------
// The costs screen
// ---------------------------------------------------------------------------

export type ScreenState = "ready" | "empty" | "loading" | "unavailable" | "waiting";

export interface CostsPageView {
  state: ScreenState;
  query: CostQuery;
  snapshot?: CostSnapshot;
  failure?: ConsoleReadFailure;
  refreshAfter?: IsoInstant;
}

const COST_BASIS = "仅计入按次计费 · 金额沿用发生时价格";

function timeZoneSelect(current: string): string {
  const zones = Intl.supportedValuesOf("timeZone");
  const options = zones.map((zone) =>
    `<option value="${escapeHtml(zone)}"${zone === current ? " selected" : ""}>${escapeHtml(zone)}</option>`,
  ).join("");
  return options;
}

function costsToolbar(query: CostQuery, extra: Record<string, string> = {}): string {
  const field = (name: string, label: string, value: string): string =>
    `<div><label for="cost-${name}">${escapeHtml(label)}</label>`
    + `<input id="cost-${name}" name="${name}" value="${escapeHtml(value)}"></div>`;
  return `<form class="toolbar" method="get" action="/operator/costs">`
    + `<div><label for="cost-timeZone">自然日时区</label><select id="cost-timeZone" name="timeZone">${timeZoneSelect(query.timeZone)}</select></div>`
    + field("start", "开始日期", query.startDateInclusive)
    + field("end", "结束日期", query.endDateInclusive)
    + field("requirement", "需求", query.requirementId ?? extra.requirement ?? "")
    + field("provider", "供应商", query.provider ?? extra.provider ?? "")
    + field("model", "模型", query.modelId ?? extra.model ?? "")
    + '<button type="submit">查看费用</button></form>';
}

function scopeSentence(snapshot: CostSnapshot): string {
  return `按 ${snapshot.scope.timeZone} 自然日 · ${COST_BASIS}`;
}

function costRow(item: CostSnapshot["items"][number], timeZone: string): string {
  const label = (name: string): string => `<span class="field-label">${escapeHtml(name)}</span>`;
  const billing = item.billing === "subscription"
    ? '<span class="status attention">订阅使用 · 不计入按次合计</span>'
    : '<span class="status">按次计费</span>';
  return `<div class="cost-row">`
    + label("日期") + escapeHtml(localDate(new Date(item.occurredAt), timeZone))
    + label("需求") + escapeHtml(`${item.requirementId} ${item.requirementTitle}`)
    + label("供应商") + escapeHtml(item.provider)
    + label("模型") + escapeHtml(item.modelId)
    + label("金额") + escapeHtml(`$${item.costUsd}`) + billing
    + "</div>";
}

function renderCostsReady(view: CostsPageView): string {
  const snapshot = view.snapshot;
  if (!snapshot) return "";
  const scope = scopeSentence(snapshot);
  const summary = `<section class="metric-grid section">`
    + `<div class="metric"><div class="metric-name">累计费用</div>`
    + `<div class="metric-value">$${escapeHtml(snapshot.totalMeteredUsd)}</div>`
    + `累计费用 $${escapeHtml(snapshot.totalMeteredUsd)}`
    + `<div class="metric-detail">${escapeHtml(scope)}</div></div>`
    + `<div class="metric"><div class="metric-name">统计范围</div>`
    + `<div class="bare"><div class="field-label">日期范围</div>${escapeHtml(snapshot.scope.startDateInclusive)} 至 ${escapeHtml(snapshot.scope.endDateInclusive)}</div>`
    + `<div class="metric-detail">起止两日均计入</div></div>`
    + `<div class="metric"><div class="metric-name">计费口径</div>`
    + `<div class="bare"><div class="field-label">计费口径</div>${escapeHtml(scope)}</div>`
    + `<div class="metric-detail">订阅使用单列，不并入按次总额</div></div>`
    + `</section>`;
  const rows = snapshot.items.length > 0
    ? `<div class="cost-lines">${snapshot.items.map((item) => costRow(item, snapshot.scope.timeZone)).join("")}</div>`
    : "";
  const breakdown = `<section class="panel flush section"><div class="section-head" style="padding:18px 18px 0">`
    + "<h2>供应商与模型明细</h2>"
    + `<span class="meta">${snapshot.items.length} 笔 · ${escapeHtml(snapshot.scope.timeZone)}</span></div>`
    + rows + "</section>";
  return summary + breakdown;
}

export function renderCostsPage(view: CostsPageView): string {
  const range = `${view.query.startDateInclusive} 至 ${view.query.endDateInclusive}`;
  let body = "";
  if (view.state === "loading") {
    body = noticeBlock({
      tone: "",
      heading: "正在读取费用",
      bare: `正在读取 ${range} 的费用`,
    });
  } else if (view.state === "unavailable") {
    body = noticeBlock({
      tone: "danger",
      heading: "无法读取费用",
      body: view.failure?.detail ?? "所选范围的费用没有载入。",
      bare: "无法读取费用",
      action: retryForm("/operator/costs", costRetryFields(view.query), "重新读取"),
    });
  } else if (view.state === "empty") {
    body = noticeBlock({
      tone: "",
      heading: "当前没有费用",
      body: `所选范围 ${range} 还没有费用，请调整日期范围或筛选条件。`,
      bare: "当前没有费用，请调整日期或筛选条件",
    });
  } else if (view.state === "waiting") {
    body = noticeBlock({
      tone: "attention",
      heading: "今日费用仍在产生",
      bare: "今日费用仍在产生，有新费用入账时自动刷新",
    });
    body += view.snapshot ? renderCostsReady(view) : "";
  } else {
    body = renderCostsReady(view);
    if (view.snapshot?.stillAccruing) {
      body += noticeBlock({
        tone: "attention",
        heading: "今日费用仍在产生",
        bare: "今日费用仍在产生，有新费用入账时自动刷新",
      });
    }
  }
  const head = pageHead("费用分析", "历史费用按使用发生时的官方价格固化，供应商之后调价不会改变这里的金额。", "<div class=\"refresh\">范围随筛选条件</div>");
  return shell({
    title: "费用分析｜Hivemind",
    current: "costs",
    body: head + costsToolbar(view.query) + body,
  });
}

function costRetryFields(query: CostQuery): Record<string, string> {
  return {
    timeZone: query.timeZone,
    start: query.startDateInclusive,
    end: query.endDateInclusive,
    ...(query.requirementId === undefined ? {} : { requirement: query.requirementId }),
    ...(query.provider === undefined ? {} : { provider: query.provider }),
    ...(query.modelId === undefined ? {} : { model: query.modelId }),
  };
}

// ---------------------------------------------------------------------------
// The work-record screen
// ---------------------------------------------------------------------------

export interface RecordsPageView {
  state: ScreenState;
  query: WorkRecordQuery;
  page?: WorkRecordSearchPage;
  detail?: WorkRecordDetail;
  failure?: ConsoleReadFailure;
  refreshAfter?: IsoInstant;
}

/** Wraps every keyword hit in its own bracket-and-highlight, so the mark is
 * text a reader can see and not a colour that only a renderer knows. */
function markMatches(content: string, ranges: readonly { start: number; end: number }[]): string {
  if (ranges.length === 0) return escapeHtml(content);
  let html = "";
  let cursor = 0;
  for (const range of ranges) {
    html += escapeHtml(content.slice(cursor, range.start));
    html += `<span class="match">【${escapeHtml(content.slice(range.start, range.end))}】</span>`;
    cursor = range.end;
  }
  html += escapeHtml(content.slice(cursor));
  return html;
}

function recordsToolbar(query: WorkRecordQuery): string {
  const timeZone = query.timeZone;
  return `<form class="toolbar" method="get" action="/operator/records">`
    + `<div><label for="record-timeZone">自然日时区</label><input id="record-timeZone" name="timeZone" value="${escapeHtml(timeZone)}"></div>`
    + `<div><label for="record-start">开始日期</label><input id="record-start" name="start" value="${escapeHtml(query.startDateInclusive)}"></div>`
    + `<div><label for="record-end">结束日期</label><input id="record-end" name="end" value="${escapeHtml(query.endDateInclusive)}"></div>`
    + `<div><label for="record-role">智能体角色</label><input id="record-role" name="role" value="${escapeHtml(query.role ?? "")}" placeholder="全部角色"></div>`
    + `<div class="wide"><label for="record-keyword">关键词</label><input id="record-keyword" name="keyword" value="${escapeHtml(query.keyword ?? "")}" placeholder="输入错误、动作或关键词"></div>`
    + '<button type="submit">搜索记录</button></form>';
}

function recordEntryText(entry: WorkRecordDetail["current"], timeZone: string): string {
  return localDateTime(entry.occurredAt, timeZone);
}

function renderRecordsReady(view: RecordsPageView): string {
  const page = view.page;
  if (!page) return "";
  const timeZone = view.query.timeZone;
  const selected = view.detail;
  const results = page.matches.length > 0
    ? `<ol class="result-list">${page.matches.map((match) => {
      const current = selected?.current.recordId === match.recordId;
      return `<li><a href="/operator/records?${recordQueryString(view.query, match.recordId)}"${current ? ' aria-current="true"' : ""}>`
        + `<strong>${escapeHtml(roleLabel(match.role))} · ${escapeHtml(localDateTime(match.occurredAt, timeZone))}</strong>`
        + `<span class="meta">${escapeHtml(match.matchedText.slice(0, 40))}</span>`
        + `</a></li>`;
    }).join("")}</ol>`
    : "";
  const detail = selected
    ? `<article class="panel"><div class="section-head"><div>`
      + `<div class="version-label">完整工作记录 · ${escapeHtml(selected.current.recordId)}</div>`
      + `<h2>${escapeHtml(roleLabel(selected.current.role))} · ${escapeHtml(localDateTime(selected.current.occurredAt, timeZone))}</h2></div>`
      + `<span class="status">第 ${selected.current.sequence} 条</span></div>`
      + `<div class="bare"><div class="field-label">时间</div>${escapeHtml(recordEntryText(selected.current, timeZone))}</div>`
      + `<div class="bare"><div class="field-label">角色</div>${escapeHtml(roleLabel(selected.current.role))}</div>`
      + `<div class="record-body section"><div class="field-label">完整内容</div>${markMatches(selected.current.content, keywordRanges(selected.current.content, view.query.keyword))}</div>`
      + `<div class="neighbor">上一条<div class="record-body">${selected.previous ? escapeHtml(selected.previous.content) : "没有更早的记录"}</div></div>`
      + `<div class="neighbor">下一条<div class="record-body">${selected.next ? escapeHtml(selected.next.content) : "后续记录尚未产生"}</div></div>`
      + "</article>"
    : "";
  return `<div class="record-split section"><section class="panel flush">`
    + `<div class="section-head" style="padding:18px 18px 0"><div><h2>匹配记录</h2>`
    + `<p class="meta">找到 ${page.matches.length} 条完整记录</p></div></div>`
    + `<div style="padding:0 18px 18px">${results}</div></section>`
    + detail + "</div>";
}

function recordQueryString(query: WorkRecordQuery, recordId?: string): string {
  const params = new URLSearchParams({
    timeZone: query.timeZone,
    start: query.startDateInclusive,
    end: query.endDateInclusive,
  });
  if (query.role) params.set("role", query.role);
  if (query.keyword) params.set("keyword", query.keyword);
  if (recordId) params.set("record", recordId);
  return params.toString();
}

function keywordRanges(content: string, keyword: string | undefined): Array<{ start: number; end: number }> {
  if (!keyword) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  const haystack = content.toLowerCase();
  const needle = keyword.toLowerCase();
  let cursor = haystack.indexOf(needle);
  while (cursor !== -1) {
    ranges.push({ start: cursor, end: cursor + keyword.length });
    cursor = haystack.indexOf(needle, cursor + needle.length);
  }
  return ranges;
}

export function renderRecordsPage(view: RecordsPageView): string {
  const conditions = `${view.query.startDateInclusive} 至 ${view.query.endDateInclusive}`;
  let body = "";
  if (view.state === "loading") {
    body = noticeBlock({
      tone: "",
      heading: "正在读取工作记录",
      bare: `正在读取 ${conditions} 的工作记录`,
    });
  } else if (view.state === "unavailable") {
    body = noticeBlock({
      tone: "danger",
      heading: "无法读取工作记录",
      body: view.failure?.detail ?? "完整记录没有载入，查询条件已保留。",
      bare: "无法读取工作记录",
      action: retryForm("/operator/records", recordRetryFields(view.query), "重新查询"),
    });
  } else if (view.state === "empty") {
    body = noticeBlock({
      tone: "",
      heading: "没有匹配记录",
      body: "请修改时间、角色或关键词，再搜索一次。",
      bare: "没有匹配记录，请修改时间、角色或关键词",
    });
  } else if (view.state === "waiting") {
    body = noticeBlock({
      tone: "attention",
      heading: "后续记录尚未产生",
      bare: "后续记录尚未产生，产生后将自动刷新",
    });
    body += renderRecordsReady(view);
  } else {
    body = renderRecordsReady(view);
    if (view.detail?.workStillRunning && view.detail.next === null) {
      body += noticeBlock({
        tone: "attention",
        heading: "后续记录尚未产生",
        bare: "后续记录尚未产生，产生后将自动刷新",
      });
    }
  }
  const head = pageHead("工作记录", "无需进入需求详情，直接搜索完整智能体记录并查看问题前后文。");
  return shell({
    title: "工作记录排查｜Hivemind",
    current: "records",
    body: head + recordsToolbar(view.query) + body,
  });
}

function recordRetryFields(query: WorkRecordQuery): Record<string, string> {
  return {
    timeZone: query.timeZone,
    start: query.startDateInclusive,
    end: query.endDateInclusive,
    ...(query.role === undefined ? {} : { role: query.role }),
    ...(query.keyword === undefined ? {} : { keyword: query.keyword }),
  };
}

// ---------------------------------------------------------------------------
// The role-configuration screen
// ---------------------------------------------------------------------------

export interface RoleConfirmation {
  kind: "save" | "restore";
  role: string;
  /** For a save, the change preview the port computed. */
  preview?: RoleChangePreview;
  /** For a restore, the version whose content becomes the new current one. */
  sourceVersion?: number;
  /** For a restore, the previous configuration. */
  next?: RoleConfiguration;
}

export interface RoleResultView {
  kind: "saved" | "conflict" | "invalid";
  version?: number;
  restoredFromVersion?: number;
  message?: string;
}

export interface RolesPageView {
  state: ScreenState;
  role: string;
  view?: RoleConfigurationView;
  failure?: ConsoleReadFailure;
  refreshAfter?: IsoInstant;
  draft?: RoleConfiguration;
  confirmation?: RoleConfirmation;
  result?: RoleResultView;
}

function differenceWord(kind: RoleConfigurationDifference["kind"]): string {
  return kind === "added" ? "新增" : kind === "removed" ? "删除" : "变更";
}

function differenceLine(difference: RoleConfigurationDifference): string {
  const before = difference.previous === undefined ? "" : `上一版：${difference.previous}`;
  const after = difference.current === undefined ? "" : `当前版：${difference.current}`;
  return `<li><span class="diff ${difference.kind}">${differenceWord(difference.kind)}</span> `
    + `<strong>${escapeHtml(FIELD_LABELS[difference.field])}</strong> `
    + `<span class="meta">${escapeHtml(before)} ${escapeHtml(after)}</span></li>`;
}

const FIELD_LABELS: Record<RoleConfigurationDifference["field"], string> = {
  prompt: "角色说明",
  provider: "供应商",
  modelId: "模型",
};

function differenceList(differences: readonly RoleConfigurationDifference[]): string {
  if (differences.length === 0) return '<p class="meta">当前版与上一版没有差异。</p>';
  return `<ul class="stack section">${differences.map(differenceLine).join("")}</ul>`;
}

function providerOptions(view: RoleConfigurationView, selected: string): string {
  return view.availableProviders.map((entry) =>
    `<option value="${escapeHtml(entry.provider)}"${entry.provider === selected ? " selected" : ""}>${escapeHtml(entry.provider)}</option>`,
  ).join("");
}

/** Every model id on offer, across providers. The list is the union so a
 * person can pick a model and be told, on save, which provider it belongs to;
 * there is no client script to narrow it when the provider changes. */
function modelOptions(view: RoleConfigurationView, selected: string): string {
  const offered = [...new Set(view.availableProviders.flatMap((entry) => entry.modelIds))].toSorted();
  return offered.map((model) =>
    `<option value="${escapeHtml(model)}"${model === selected ? " selected" : ""}>${escapeHtml(model)}</option>`,
  ).join("");
}

function renderRolesBrowse(view: RolesPageView): string {
  const role = view.role;
  const value = view.view;
  if (!value) return "";
  const current = value.current;
  const previous = value.previous;
  const draft = view.draft ?? current.configuration;
  const unsaved = JSON.stringify(draft) !== JSON.stringify(current.configuration)
    ? '<span class="status attention">有未提交的修改</span>'
    : "";
  const previousPanel = previous
    ? `<section class="panel"><div class="section-head"><div><div class="version-label">上一版 v${previous.version} · ${escapeHtml(previous.createdAt)}</div>`
      + "<h2>上一版</h2></div></div>"
      + `<div class="bare"><div class="field-label">供应商</div>${escapeHtml(previous.configuration.provider)}</div>`
      + `<div class="bare"><div class="field-label">模型</div>${escapeHtml(previous.configuration.modelId)}</div>`
      + `<div class="section"><div class="field-label">角色说明</div><div class="prompt-box">${escapeHtml(previous.configuration.prompt)}</div></div>`
      + `<div class="notice attention section"><p>恢复会把上一版复制成新的当前版，只用于之后新开始的${escapeHtml(roleLabel(role))}。</p></div>`
      + `<form class="actions section" method="post" action="/operator/roles">`
      + `<input type="hidden" name="role" value="${escapeHtml(role)}">`
      + `<input type="hidden" name="action" value="restore">`
      + `<input type="hidden" name="sourceVersion" value="${previous.version}">`
      + '<button class="secondary" type="submit">恢复上一版</button></form></section>'
    : `<section class="panel"><h2>上一版</h2>`
      + `<div class="bare"><div class="field-label">上一版</div>当前角色还没有上一版，保存一次改动后即可对照</div></section>`;
  const editPanel = `<form class="panel" method="post" action="/operator/roles"><div class="section-head"><div>`
    + `<div class="version-label">当前版 v${current.version} · ${escapeHtml(current.createdAt)}</div>`
    + "<h2>当前版</h2></div>" + unsaved + "</div>"
    + `<input type="hidden" name="role" value="${escapeHtml(role)}">`
    + `<input type="hidden" name="action" value="save">`
    + `<div class="section"><label for="role-provider">模型供应商</label>`
    + `<select id="role-provider" name="provider">${providerOptions(value, draft.provider)}</select></div>`
    + `<div class="section"><label for="role-model">模型</label>`
    + `<select id="role-model" name="model">${modelOptions(value, draft.modelId)}</select></div>`
    + `<div class="section"><label for="role-prompt">角色说明</label>`
    + `<textarea id="role-prompt" name="prompt">${escapeHtml(draft.prompt)}</textarea></div>`
    + `<div class="notice attention section"><p>保存只影响之后新开始的${escapeHtml(roleLabel(role))}；已经开始的智能体不变。</p></div>`
    + '<div class="actions section"><button type="submit">保存为新版本</button></div></form>';
  return `<section class="panel flush section"><div class="section-head" style="padding:18px 18px 0">`
    + `<div><h2>版本对照</h2><p>${escapeHtml(roleLabel(role))} · 当前版与上一版</p></div></div>`
    + `<div style="padding:0 18px 18px">${differenceList(value.differences)}</div></section>`
    + `<div class="split section">${editPanel}${previousPanel}</div>`;
}

function renderRolesConfirmation(view: RolesPageView): string {
  const confirmation = view.confirmation;
  if (!confirmation) return "";
  const role = confirmation.role;
  const label = roleLabel(role);
  if (confirmation.kind === "restore") {
    const source = confirmation.next;
    if (!source) return "";
    return shell({
      title: "恢复角色配置｜Hivemind",
      current: "roles",
      body: pageHead(`恢复${label}配置`, "确认后上一版成为新的当前版。")
        + `<section class="panel section"><h2>即将恢复的内容</h2>`
        + `<div class="bare"><div class="field-label">供应商</div>${escapeHtml(source.provider)}</div>`
        + `<div class="bare"><div class="field-label">模型</div>${escapeHtml(source.modelId)}</div>`
        + `<div class="section"><div class="field-label">角色说明</div><div class="prompt-box">${escapeHtml(source.prompt)}</div></div></section>`
        + `<div class="notice attention section"><h2>恢复的影响</h2>`
        + `<div class="bare"><div class="field-label">影响范围</div>只影响之后新开始的${escapeHtml(label)}；已经开始的智能体不变。</div></div>`
        + `<form class="actions section" method="post" action="/operator/roles">`
        + `<input type="hidden" name="role" value="${escapeHtml(role)}">`
        + `<input type="hidden" name="action" value="restore">`
        + `<input type="hidden" name="sourceVersion" value="${confirmation.sourceVersion ?? 0}">`
        + '<input type="hidden" name="confirm" value="1">'
        + '<button type="submit">确认恢复</button>'
        + '<button class="secondary" type="submit" name="cancel" value="1">取消</button></form>',
    });
  }
  const preview = confirmation.preview;
  const issues = preview && !preview.valid
    ? `<div class="notice danger section"><h2>所选内容还不能保存</h2>`
      + preview.validationIssues.map((issue) =>
        `<div class="bare"><div class="field-label">请改正</div>${escapeHtml(issue.field === "modelId" ? "所选模型不属于该供应商，请重新选择" : "所选供应商不存在，请重新选择")}</div>`).join("")
      + "</div>"
    : "";
  const canConfirm = preview?.valid === true;
  const confirmButton = canConfirm
    ? '<input type="hidden" name="confirm" value="1"><button type="submit">确认保存</button>'
    : "";
  return shell({
    title: "保存角色配置｜Hivemind",
    current: "roles",
    body: pageHead(`保存${label}配置`, "确认后新版本生效，历史版本保留。")
      + `<section class="panel section"><h2>本次变更</h2>${differenceList(preview?.differences ?? [])}</section>`
      + issues
      + `<div class="notice attention section"><h2>保存的影响</h2>`
      + `<div class="bare"><div class="field-label">影响范围</div>只影响之后新开始的${escapeHtml(label)}；已经开始的智能体不变。</div></div>`
      + `<form class="actions section" method="post" action="/operator/roles">`
      + `<input type="hidden" name="role" value="${escapeHtml(role)}">`
      + `<input type="hidden" name="action" value="save">`
      + `<input type="hidden" name="prompt" value="${escapeHtml(confirmation.preview?.next.prompt ?? "")}">`
      + `<input type="hidden" name="provider" value="${escapeHtml(confirmation.preview?.next.provider ?? "")}">`
      + `<input type="hidden" name="model" value="${escapeHtml(confirmation.preview?.next.modelId ?? "")}">`
      + confirmButton
      + '<button class="secondary" type="submit" name="cancel" value="1">取消</button></form>',
  });
}

function renderRolesResult(view: RolesPageView): string {
  const result = view.result;
  if (!result) return "";
  const role = view.role;
  const label = roleLabel(role);
  const heading = result.kind === "saved" ? "保存成功" : result.kind === "conflict" ? "配置已被他人更新" : "所选内容还不能保存";
  const detail = result.kind === "saved"
    ? (result.restoredFromVersion === undefined
      ? `已保存为第 ${result.version ?? 0} 版`
      : `已恢复上一版并保存为第 ${result.version ?? 0} 版`)
    : (result.message ?? "请刷新后重试。");
  return shell({
    title: "角色配置结果｜Hivemind",
    current: "roles",
    body: pageHead(`${label}配置`, "改动只影响之后新开始的智能体。")
      + `<section class="notice ${result.kind === "saved" ? "success" : "danger"} section" aria-live="polite">`
      + `<h2 role="status">${escapeHtml(heading)}</h2>`
      + `<div class="bare"><div class="field-label">结果</div>${escapeHtml(detail)}</div>`
      + `<p>只影响之后新开始的${escapeHtml(label)}；已经开始的智能体不变。</p></section>`
      + `<div class="actions section"><a class="button" href="/operator/roles?role=${encodeURIComponent(role)}">返回角色配置</a></div>`,
  });
}

export function renderRolesPage(view: RolesPageView): string {
  if (view.result) return renderRolesResult(view);
  if (view.confirmation) return renderRolesConfirmation(view);
  const role = view.role;
  const label = roleLabel(role);
  let body = "";
  if (view.state === "loading") {
    body = noticeBlock({ tone: "", heading: "正在读取角色配置", bare: `正在读取${label}的当前配置与版本` });
  } else if (view.state === "unavailable") {
    body = noticeBlock({
      tone: "danger",
      heading: "无法读取角色配置",
      body: view.failure?.detail ?? "当前版和上一版没有载入，已有配置不会改变。",
      bare: "无法读取角色配置",
      action: retryForm("/operator/roles", { role }, "重新读取"),
    });
  } else if (view.state === "waiting") {
    body = noticeBlock({ tone: "attention", heading: "保存结果尚未确认", bare: "保存结果尚未确认，确认后将自动刷新" });
    body += renderRolesBrowse(view);
  } else if (view.state === "empty") {
    body = noticeBlock({ tone: "", heading: "还没有角色配置", body: `还没有 ${label} 的配置。`, bare: `还没有${label}的配置，保存一次改动后即可对照` });
  } else {
    body = renderRolesBrowse(view);
  }
  const head = pageHead("智能体角色配置", `修改只影响之后新开始的智能体；已经开始的智能体继续使用原配置。`, `<span class="status">${escapeHtml(label)}</span>`);
  return shell({ title: "智能体角色配置｜Hivemind", current: "roles", body: head + body });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface MobileConsoleDependencies {
  access: ConsoleAccessPolicy;
  costs: ConsoleCostPort;
  records: ConsoleWorkRecordPort;
  roles: ConsoleRoleConfigurationPort;
  /** Injected so a round's pages are reproducible; defaults to the wall clock. */
  now?: () => Date;
}

const FORCED_STATES = new Set<ScreenState>(["loading", "empty", "unavailable", "waiting"]);

function forcedState(query: unknown): ScreenState | null {
  const requested = (query as { state?: unknown } | null | undefined)?.state;
  if (typeof requested !== "string") return null;
  const normalized = requested === "error" ? "unavailable" : requested;
  return FORCED_STATES.has(normalized as ScreenState) ? normalized as ScreenState : null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

function defaultQuery(now: Date): { timeZone: string; start: string; end: string } {
  const timeZone = "Asia/Shanghai";
  const end = localDate(now, timeZone);
  return { timeZone, start: shiftDate(end, -6), end };
}

function costQueryOf(query: unknown, now: Date): CostQuery {
  const raw = (query ?? {}) as Record<string, unknown>;
  const defaults = defaultQuery(now);
  const timeZone = text(raw.timeZone) ?? defaults.timeZone;
  const parsed: CostQuery = {
    timeZone,
    startDateInclusive: text(raw.start) ?? defaults.start,
    endDateInclusive: text(raw.end) ?? defaults.end,
  };
  const requirementId = text(raw.requirement);
  const provider = text(raw.provider);
  const modelId = text(raw.model);
  if (requirementId !== undefined) parsed.requirementId = requirementId;
  if (provider !== undefined) parsed.provider = provider;
  if (modelId !== undefined) parsed.modelId = modelId;
  return parsed;
}

function recordQueryOf(query: unknown, now: Date): WorkRecordQuery {
  const raw = (query ?? {}) as Record<string, unknown>;
  const defaults = defaultQuery(now);
  const parsed: WorkRecordQuery = {
    timeZone: text(raw.timeZone) ?? defaults.timeZone,
    startDateInclusive: text(raw.start) ?? defaults.start,
    endDateInclusive: text(raw.end) ?? defaults.end,
  };
  const role = text(raw.role);
  const keyword = text(raw.keyword);
  if (role !== undefined) parsed.role = role;
  if (keyword !== undefined) parsed.keyword = keyword;
  return parsed;
}

/** The value a read handed back, or the reason it could not. Never throws. */
async function readInto<Value>(load: () => Promise<Value>): Promise<{ ok: true; value: Value } | { ok: false; failure: ConsoleReadFailure }> {
  try {
    return { ok: true, value: await load() };
  } catch (cause) {
    return { ok: false, failure: { code: "unavailable", detail: cause instanceof Error ? cause.message : "read failed", retryable: true } };
  }
}

/** The load state for one read, with the forced states overriding the result
 * only where there is nothing to retain. */
async function costsState(
  dependencies: MobileConsoleDependencies,
  query: CostQuery,
  forced: ScreenState | null,
  previous?: ConsoleLoadState<CostQuery, CostSnapshot>,
): Promise<ConsoleLoadState<CostQuery, CostSnapshot>> {
  if (forced === "loading") return transitionConsoleLoadState(previous, { status: "loading", query });
  if (forced === "empty") return transitionConsoleLoadState(previous, { status: "empty", query });
  if (forced === "unavailable") {
    return transitionConsoleLoadState(previous, {
      status: "unavailable",
      query,
      failure: { code: "unavailable", detail: "读取被要求重试", retryable: true },
    });
  }
  const read = await readInto(() => dependencies.costs.queryCosts(query));
  if (!read.ok) return transitionConsoleLoadState(previous, { status: "unavailable", query, failure: read.failure });
  if (read.value.items.length === 0) return transitionConsoleLoadState(previous, { status: "empty", query });
  if (forced === "waiting") {
    return transitionConsoleLoadState(previous, {
      status: "waiting",
      query,
      refreshAfter: read.value.refreshAfter ?? read.value.generatedAt,
    });
  }
  return transitionConsoleLoadState(previous, { status: "ready", query, value: read.value });
}

function stateOf<Query, Value>(state: ConsoleLoadState<Query, Value>): ScreenState {
  return state.status === "ready" ? "ready" : state.status;
}

function valueOf<Query, Value>(state: ConsoleLoadState<Query, Value>): Value | undefined {
  if (state.status === "ready" || state.status === "waiting") return state.value;
  if (state.status === "loading" || state.status === "unavailable") return state.retained;
  return undefined;
}

function failureOf<Query, Value>(state: ConsoleLoadState<Query, Value>): ConsoleReadFailure | undefined {
  return state.status === "unavailable" ? state.failure : undefined;
}

function refreshOf<Query, Value>(state: ConsoleLoadState<Query, Value>): IsoInstant | undefined {
  return state.status === "waiting" ? state.refreshAfter : undefined;
}

function queryOf<Query, Value>(state: ConsoleLoadState<Query, Value>): Query {
  return state.query;
}

/**
 * Registers the cost, record and role screens behind the access boundary.
 *
 * The gate runs before every data route: a denied request receives the access
 * screen and nothing else, so no read port is called and no operator data can
 * leak even by accident. The routes are registered at both the `/operator/*`
 * paths the console navigation uses and the short paths a person may type.
 */
export async function registerMobileConsoleRoutes(
  app: FastifyInstance,
  dependencies: MobileConsoleDependencies,
): Promise<void> {
  const now = (): Date => dependencies.now?.() ?? new Date();

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const guard = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const decision = dependencies.access.decide({ remoteAddress: request.ip });
    if (decision.allowed) return true;
    await reply.code(403).type("text/html; charset=utf-8").send(renderOperatorAccessPage(decision));
    return false;
  };

  const accessRoute = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    sendHtml(reply, renderOperatorAccessPage(dependencies.access.decide({ remoteAddress: request.ip })));

  const costsRoute = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!(await guard(request, reply))) return reply;
    const query = costQueryOf(request.query, now());
    const state = await costsState(dependencies, query, forcedState(request.query));
    return sendHtml(reply, renderCostsPage({
      state: stateOf(state),
      query: queryOf(state),
      ...(valueOf(state) === undefined ? {} : { snapshot: valueOf(state)! }),
      ...(failureOf(state) === undefined ? {} : { failure: failureOf(state)! }),
      ...(refreshOf(state) === undefined ? {} : { refreshAfter: refreshOf(state)! }),
    }));
  };

  const recordsRoute = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!(await guard(request, reply))) return reply;
    const query = recordQueryOf(request.query, now());
    const forced = forcedState(request.query);
    if (forced === "loading") {
      return sendHtml(reply, renderRecordsPage({ state: "loading", query }));
    }
    if (forced === "unavailable") {
      return sendHtml(reply, renderRecordsPage({
        state: "unavailable",
        query,
        failure: { code: "unavailable", detail: "读取被要求重试", retryable: true },
      }));
    }
    const search = await readInto(() => dependencies.records.searchRecords(query));
    if (!search.ok) {
      return sendHtml(reply, renderRecordsPage({ state: "unavailable", query, failure: search.failure }));
    }
    if (search.value.matches.length === 0) {
      return sendHtml(reply, renderRecordsPage({ state: "empty", query, page: search.value }));
    }
    if (forced === "empty") {
      return sendHtml(reply, renderRecordsPage({ state: "empty", query, page: search.value }));
    }
    const recordId = text((request.query as { record?: unknown }).record) ?? search.value.matches[0]!.recordId;
    const record = await readInto(() => dependencies.records.readRecord(recordId));
    const detail = record.ok ? record.value : null;
    if (forced === "waiting") {
      return sendHtml(reply, renderRecordsPage({
        state: "waiting",
        query,
        page: search.value,
        ...(detail === null ? {} : { detail }),
        refreshAfter: "1970-01-01T00:00:00.000Z",
      }));
    }
    return sendHtml(reply, renderRecordsPage({
      state: "ready",
      query,
      page: search.value,
      ...(detail === null ? {} : { detail }),
    }));
  };

  const rolesGetRoute = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!(await guard(request, reply))) return reply;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const role = text(query.role) ?? "verifier";
    const forced = forcedState(query);
    if (forced === "loading") {
      return sendHtml(reply, renderRolesPage({ state: "loading", role }));
    }
    if (forced === "unavailable") {
      return sendHtml(reply, renderRolesPage({
        state: "unavailable",
        role,
        failure: { code: "unavailable", detail: "读取被要求重试", retryable: true },
      }));
    }
    const read = await readInto(() => dependencies.roles.readRole(role));
    if (!read.ok) {
      return sendHtml(reply, renderRolesPage({ state: "unavailable", role, failure: read.failure }));
    }
    if (read.value === null) {
      return sendHtml(reply, renderRolesPage({ state: "empty", role }));
    }
    if (forced === "empty") {
      return sendHtml(reply, renderRolesPage({ state: "empty", role }));
    }
    const view = read.value;
    const draft = roleDraft(view, query);
    if (text(query.action) === "restore" && view.previous) {
      return sendHtml(reply, renderRolesPage({
        state: "ready",
        role,
        view,
        confirmation: { kind: "restore", role, sourceVersion: view.previous.version, next: view.previous.configuration },
      }));
    }
    if (text(query.action) === "save") {
      const preview = dependencies.roles.previewRoleChange(view.current, draft, view.availableProviders);
      return sendHtml(reply, renderRolesPage({
        state: "ready",
        role,
        view,
        draft,
        confirmation: { kind: "save", role, preview },
      }));
    }
    return sendHtml(reply, renderRolesPage({
      state: forced === "waiting" ? "waiting" : "ready",
      role,
      view,
      draft,
      ...(forced === "waiting" ? { refreshAfter: "1970-01-01T00:00:00.000Z" } : {}),
    }));
  };

  const rolesPostRoute = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!(await guard(request, reply))) return reply;
    const body = (request.body ?? {}) as Record<string, string>;
    const role = text(body.role) ?? "verifier";
    const read = await readInto(() => dependencies.roles.readRole(role));
    if (!read.ok || read.value === null) {
      return sendHtml(reply, renderRolesPage({
        state: read.ok ? "empty" : "unavailable",
        role,
        ...(read.ok ? {} : { failure: read.failure }),
      }));
    }
    const view = read.value;
    const action = text(body.action) ?? "save";
    if (body.cancel === "1") {
      return sendHtml(reply, renderRolesPage({ state: "ready", role, view }));
    }
    if (action === "restore") {
      const sourceVersion = Number(body.sourceVersion ?? 0);
      if (body.confirm !== "1") {
        const source = view.current.version === sourceVersion ? view.previous : view.previous;
        return sendHtml(reply, renderRolesPage({
          state: "ready",
          role,
          view,
          confirmation: {
            kind: "restore",
            role,
            sourceVersion,
            ...(source ? { next: source.configuration } : {}),
          },
        }));
      }
      const result = await dependencies.roles.restoreRole({
        role,
        expectedCurrentVersion: view.current.version,
        sourceVersion,
        updatedBy: "owner",
        idempotencyKey: `restore:${role}:${view.current.version}:${sourceVersion}`,
        confirmed: true,
      });
      return sendHtml(reply, renderRolesPage({ state: "ready", role, result: roleResult(result) }));
    }
    const draft: RoleConfiguration = {
      role,
      prompt: body.prompt ?? view.current.configuration.prompt,
      provider: body.provider ?? view.current.configuration.provider,
      modelId: body.model ?? view.current.configuration.modelId,
    };
    const preview = dependencies.roles.previewRoleChange(view.current, draft, view.availableProviders);
    // An incompatible provider/model cannot be confirmed at all: the person is
    // shown what to correct instead of a save that would create a version the
    // role could not run.
    if (!preview.valid || body.confirm !== "1") {
      return sendHtml(reply, renderRolesPage({
        state: "ready",
        role,
        view,
        draft,
        confirmation: { kind: "save", role, preview },
      }));
    }
    const result = await dependencies.roles.saveRole({
      preview,
      updatedBy: "owner",
      idempotencyKey: `save:${role}:${view.current.version}`,
      confirmed: true,
    });
    return sendHtml(reply, renderRolesPage({ state: "ready", role, result: roleResult(result) }));
  };

  for (const path of ["/operator/access", "/access"]) app.get(path, accessRoute);
  for (const path of ["/operator/costs", "/costs"]) app.get(path, costsRoute);
  for (const path of ["/operator/records", "/records"]) app.get(path, recordsRoute);
  for (const path of ["/operator/roles", "/roles"]) {
    app.get(path, rolesGetRoute);
    app.post(path, rolesPostRoute);
  }
  app.get("/", async (_request, reply) => reply.redirect("/operator/costs", 302));
}

function roleDraft(view: RoleConfigurationView, query: Record<string, unknown>): RoleConfiguration {
  const current = view.current.configuration;
  return {
    role: current.role,
    prompt: text(query.prompt) ?? current.prompt,
    provider: text(query.provider) ?? current.provider,
    modelId: text(query.model) ?? current.modelId,
  };
}

function roleResult(result: RoleMutationResult): RoleResultView {
  if (result.status === "saved") {
    return {
      kind: "saved",
      version: result.current.version,
      ...(result.current.restoredFromVersion === undefined ? {} : { restoredFromVersion: result.current.restoredFromVersion }),
    };
  }
  if (result.status === "conflict") return { kind: "conflict", message: result.detail };
  if (result.status === "invalid") {
    const issue = result.issues[0];
    const message = issue?.code === "model_not_offered_by_provider"
      ? "所选模型不属于该供应商，请重新选择"
      : issue?.code === "unknown_provider"
        ? "所选供应商不存在，请重新选择"
        : "所选内容不合法。";
    return { kind: "invalid", message };
  }
  return { kind: "saved", message: "保存结果尚未确认。" };
}
