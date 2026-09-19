import type { FastifyInstance } from "fastify";
import {
  STORY_PROGRESS_COPY,
  currentRound,
  formatLimitLine,
  formatLimitStateLine,
  formatRoundBlockerLine,
  formatRoundCostValue,
  formatRoundLabel,
  formatRoundPanelHeading,
  formatRoundPhaseLine,
  formatRoundResultLine,
  formatRoundTriggerLine,
  formatTotalCostValue,
  formatWorkStateLine,
  type StoryProgressReadResult,
  type StoryProgressRound,
  type StoryProgressSnapshot,
} from "./story-progress.js";

/**
 * The requirement detail screen, rendered as a document by the process that
 * holds the central ledger.
 *
 * It is server-rendered rather than a browser bundle because the console is
 * mounted by whatever process has the store, and a screen that only exists
 * after somebody ran a build is a screen missing on the machine that needs it.
 * The page reads exactly one snapshot and writes nothing; every word it shows
 * comes from `story-progress.ts`, so the page and the JSON API cannot name the
 * same thing differently.
 *
 * The four whole-page states are reached by `?state=`, the same convention the
 * interface contract's prototypes use, so a browser lane can address each one
 * without driving the application. `?state=loading` keeps the content a person
 * was reading and only adds the reading line, because a refresh that blanks the
 * screen is the failure the scenario is about.
 */

/** The console serves one requirement's detail document here; `:storyId` is
 * the Story id. The JSON reading of the same snapshot lives on
 * `STORY_PROGRESS_API_PATH`. */
export const STORY_PROGRESS_PAGE_PATH = "/stories/:storyId/progress";

export interface StoryProgressPageQuery {
  /** One of the four whole-page states, or absent for the page's own state. */
  state?: string | undefined;
  /** The round a person selected, as it appears in the switcher. */
  round?: string | undefined;
}

/**
 * Which round the page shows and which of the four states it is in.
 *
 * `loading` is an overlay on the content, not a replacement for it: the
 * snapshot and the selection stay, exactly as the client state machine keeps
 * them. `empty` is a read that worked and found no round; `error` is a read
 * that did not work.
 */
export interface StoryProgressPageView {
  readonly status: "ready" | "empty" | "loading" | "error";
  readonly snapshot: StoryProgressSnapshot | null;
  readonly selectedRoundId: number | null;
  /** Whether the current round's result line is forced to the pending copy. */
  readonly pendingResult: boolean;
}

const WHOLE_PAGE_STATES: ReadonlySet<string> = new Set(["empty", "loading", "error", "waiting"]);

function parseRound(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const round = Number(value);
  return Number.isInteger(round) ? round : null;
}

function selectedRoundOf(snapshot: StoryProgressSnapshot, selectedRoundId: number | null): StoryProgressRound | null {
  if (selectedRoundId !== null) {
    const picked = snapshot.rounds.find((entry) => entry.round === selectedRoundId);
    if (picked) return picked;
  }
  return snapshot.rounds.at(-1) ?? null;
}

/**
 * The page's state from one read and the query a browser arrived with.
 *
 * A read that failed is always the error page, whatever the query said: the
 * only thing a person can do is read again. A read that worked can still be
 * asked to show one of the whole-page states, which is how the loading and
 * waiting states are addressable at all on a server-rendered page.
 */
export function storyProgressPageView(
  result: StoryProgressReadResult,
  query: StoryProgressPageQuery,
): StoryProgressPageView {
  const requested = query.state !== undefined && WHOLE_PAGE_STATES.has(query.state) ? query.state : null;
  const selectedRoundId = parseRound(query.round);
  const snapshot = result.kind === "progress" ? result.snapshot : null;
  if (requested === "error" || result.kind === "failed" || result.kind === "invalid_projection") {
    return { status: "error", snapshot, selectedRoundId, pendingResult: false };
  }
  if (requested === "empty" || result.kind === "empty" || result.kind === "not_found") {
    return { status: "empty", snapshot: null, selectedRoundId: null, pendingResult: false };
  }
  if (snapshot === null) {
    // The query asked for a state that needs a snapshot the read did not
    // produce. A person gets the honest empty page rather than invented data.
    return { status: "empty", snapshot: null, selectedRoundId: null, pendingResult: false };
  }
  if (requested === "loading") {
    return { status: "loading", snapshot, selectedRoundId, pendingResult: false };
  }
  return {
    status: "ready",
    snapshot,
    selectedRoundId,
    pendingResult: requested === "waiting",
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The page's stylesheet. Every colour, size, radius and gap is a value from
 * the interface contract's token table; a value that is not in the table is
 * not defined here.
 */
const PAGE_STYLE = `
:root{
  --color-page:#f4f7fa;--color-surface:#ffffff;--color-text:#172b3a;--color-text-muted:#526477;
  --color-border:#cbd5df;--color-action:#173f63;--color-danger:#b42318;--color-focus:#0b6bcb;
  --color-surface-danger:#fff0ef;--color-surface-selected:#e9f1f8;
  --space-inline-tight:4px;--space-control-gap:8px;--space-content-gap:12px;--space-section-gap:20px;
  --space-page-gutter:28px;--space-page-gutter-mobile:16px;
  --font-interface:"IBM Plex Sans","Segoe UI",sans-serif;--font-numeric:"IBM Plex Mono","SFMono-Regular",monospace;
  --font-caption:12px;--font-body:14px;--font-body-large:16px;--font-heading-small:18px;
  --font-heading-page:26px;--font-metric:30px;
  --weight-regular:400;--weight-medium:550;--weight-strong:700;
  --radius-control:6px;--radius-panel:10px;--radius-pill:999px;
  --shadow-raised:0 2px 8px #172b3a14;--layer-sticky:10;--layer-navigation:20
}
*{box-sizing:border-box}
html{background:var(--color-page);color:var(--color-text);font-family:var(--font-interface);font-size:var(--font-body);line-height:1.5}
body{margin:0;min-width:320px}
a{color:var(--color-action);text-underline-offset:3px}
a[href]{display:inline-flex;align-items:center;min-width:44px;min-height:44px}
button{font:inherit;color:inherit}
button,.button,.nav-link,.mobile-link{min-height:44px;min-width:44px}
button,.button{border:1px solid var(--color-action);border-radius:var(--radius-control);background:var(--color-action);color:var(--color-surface);font-weight:var(--weight-medium);padding:10px 16px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:var(--space-control-gap);text-decoration:none}
button:hover,.button:hover{filter:brightness(.94)}
.button.secondary{background:var(--color-surface);color:var(--color-action);border-color:var(--color-border)}
:focus-visible{outline:3px solid var(--color-focus);outline-offset:2px}
h1{font-size:var(--font-heading-page);line-height:1.2;margin:0 0 5px}
h2{font-size:var(--font-heading-small);margin:0}
p{margin:0;max-width:76ch}
.shell{display:grid;grid-template-columns:224px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;background:var(--color-surface);border-right:1px solid var(--color-border);padding:24px 16px;z-index:var(--layer-sticky)}
.brand{font-size:var(--font-heading-small);font-weight:var(--weight-strong);padding:0 12px 18px}
.brand small{display:block;color:var(--color-text-muted);font-size:var(--font-caption);font-weight:var(--weight-regular);margin-top:2px}
.nav{display:grid;gap:4px}
.nav-link{display:flex;align-items:center;padding:10px 12px;border-radius:var(--radius-control);text-decoration:none;color:var(--color-text);font-weight:var(--weight-medium)}
.nav-link[aria-current="page"]{background:var(--color-surface-selected);color:var(--color-action)}
.network-note{position:absolute;bottom:24px;left:28px;color:var(--color-text-muted);font-size:var(--font-caption)}
main{min-width:0;padding:24px var(--space-page-gutter) 104px;max-width:1440px;width:100%;margin:0 auto}
.page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-section-gap);margin-bottom:24px}
.page-head p{color:var(--color-text-muted)}
.back-link{display:inline-flex;align-items:center;margin-bottom:8px}
.refresh{font-size:var(--font-caption);color:var(--color-text-muted);white-space:nowrap;padding-top:7px}
.section{margin-top:var(--space-section-gap)}
.panel{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel);padding:18px}
.panel + .panel{margin-top:var(--space-content-gap)}
.read-state{margin:0 0 var(--space-content-gap);color:var(--color-text-muted);font-size:var(--font-caption)}
.line{margin:var(--space-content-gap) 0 0;font-size:var(--font-body-large)}
.money{margin:var(--space-inline-tight) 0 var(--space-section-gap);font-family:var(--font-numeric);font-variant-numeric:tabular-nums;font-size:var(--font-body-large)}
.tabs{display:flex;flex-wrap:wrap;gap:var(--space-control-gap);margin-top:var(--space-content-gap)}
.tab{min-height:44px;padding:9px 13px;border:1px solid var(--color-border);border-radius:var(--radius-control);background:var(--color-surface);color:var(--color-text);text-decoration:none}
.tab[aria-selected="true"]{background:var(--color-surface-selected);border-color:var(--color-action);color:var(--color-action);font-weight:var(--weight-strong)}
.subheading{margin-top:var(--space-section-gap)}
.round-list{list-style:none;margin:var(--space-content-gap) 0 0;padding:0}
.round-entry{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto;gap:var(--space-content-gap);align-items:center;width:100%;min-height:44px;padding:10px 0;border:0;border-top:1px solid var(--color-border);background:transparent;color:var(--color-text);text-align:left}
.round-entry strong{display:block}
.round-entry .meta{color:var(--color-text-muted);font-size:var(--font-caption)}
.notice{border:1px solid var(--color-border);border-left:4px solid var(--color-danger);border-radius:var(--radius-control);padding:12px 14px;background:var(--color-surface-danger)}
.notice-message{margin:0;font-size:var(--font-heading-small);font-weight:var(--weight-medium)}
.notice button{margin-top:var(--space-content-gap)}
.state-page{display:flex;justify-content:center;min-height:48vh;align-items:center}
.state-card{width:min(560px,100%);padding:30px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-panel)}
.mobile-nav{display:none}
@media (max-width:760px){
  .shell{display:block}
  .sidebar{display:none}
  main{padding:18px var(--space-page-gutter-mobile) 104px}
  .page-head{display:block;margin-bottom:18px}
  .round-entry{grid-template-columns:1fr}
  .mobile-nav{position:fixed;display:grid;left:0;right:0;bottom:0;background:var(--color-surface);border-top:1px solid var(--color-border);box-shadow:var(--shadow-raised);z-index:var(--layer-navigation)}
  .mobile-link{display:flex;align-items:center;justify-content:center;text-align:center;padding:8px 3px;color:var(--color-action);font-weight:var(--weight-strong);text-decoration:none}
}
`;

const DESKTOP_NAV: readonly { label: string; href: string }[] = [
  { label: "运行总览", href: "/" },
  { label: "费用分析", href: "/costs" },
  { label: "角色配置", href: "/roles" },
  { label: "工作记录", href: "/records" },
];

function renderSidebar(): string {
  return `<aside class="sidebar"><div class="brand">Hivemind<small>内网运行控制台</small></div>`
    + `<nav class="nav" aria-label="主要导航">`
    + DESKTOP_NAV.map((link) => `<a class="nav-link" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("")
    + `</nav><div class="network-note">家庭网络 · 已连接</div></aside>`;
}

/** The one fixed entry a narrow viewport shows: back to the current round. */
function renderMobileNavigation(view: StoryProgressPageView): string {
  const snapshot = view.snapshot;
  const present = snapshot === null ? null : selectedRoundOf(snapshot, view.selectedRoundId);
  const currentRoundId = snapshot === null ? null : currentRound(snapshot)?.round ?? null;
  // A bare `#current` fragment left a person who had opened a history round on
  // that history round: following a fragment moves nothing on a server-
  // rendered page. The entry names the round the card is actually in, so
  // choosing 第 2 轮 and tapping it lands back on the current one. With no
  // snapshot there is no round to name and the entry re-reads this requirement.
  const href = currentRoundId === null ? "" : `?round=${currentRoundId}`;
  const current = present !== null && currentRoundId !== null && present.round === currentRoundId
    ? ' aria-current="page"'
    : "";
  return `<nav class="mobile-nav" aria-label="手机导航">`
    + `<a class="mobile-link" href="${escapeHtml(href)}"${current}>${escapeHtml(STORY_PROGRESS_COPY.currentRunEntry)}</a>`
    + `</nav>`;
}

function renderTitleBar(subtitle: string | null): string {
  return `<header class="page-head"><div><h1 class="page-title">需求与任务详情</h1>`
    + (subtitle === null ? "" : `<p>${escapeHtml(subtitle)}</p>`)
    + `</div></header>`;
}

function renderRoundPanel(
  round: StoryProgressRound,
  currentRoundId: number,
  pendingResult: boolean,
): string {
  const heading = formatRoundPanelHeading(round.round, currentRoundId);
  const resultLine = pendingResult && round.round === currentRoundId
    ? STORY_PROGRESS_COPY.resultsPending
    : formatRoundResultLine(round);
  return `<section class="panel section" aria-labelledby="round-panel-title">`
    + `<h2 id="round-panel-title">${escapeHtml(heading)}</h2>`
    + `<p class="line" role="status">${escapeHtml(formatRoundTriggerLine(round))}</p>`
    + `<p class="line">${escapeHtml(formatRoundPhaseLine(round))}</p>`
    + `<p class="line" role="status">${escapeHtml(resultLine)}</p>`
    + `</section>`;
}

function renderCostPanel(snapshot: StoryProgressSnapshot, round: StoryProgressRound, currentRoundId: number): string {
  const limit = formatLimitLine(snapshot);
  const limitState = formatLimitStateLine(snapshot);
  return `<section class="panel section" aria-labelledby="cost-title">`
    + `<h2 id="cost-title">${escapeHtml(STORY_PROGRESS_COPY.roundCostHeading)}</h2>`
    + `<p class="money">${escapeHtml(formatRoundCostValue(round, currentRoundId))}</p>`
    + (limit === null ? "" : `<p class="line" role="status">${escapeHtml(limit)}</p>`)
    + (limitState === null ? "" : `<p class="line" role="status">${escapeHtml(limitState)}</p>`)
    + (limitState === null ? "" : `<p class="line" role="status">${escapeHtml(formatWorkStateLine(snapshot))}</p>`)
    + `<h2>${escapeHtml(STORY_PROGRESS_COPY.totalCostHeading)}</h2>`
    + `<p class="money">${escapeHtml(formatTotalCostValue(snapshot.totalCostUsd))}</p>`
    + `</section>`;
}

function renderBlockerPanel(round: StoryProgressRound): string {
  return `<section class="panel section" aria-labelledby="blocker-title">`
    + `<h2 id="blocker-title">卡点</h2>`
    + `<p class="line" role="status">${escapeHtml(formatRoundBlockerLine(round))}</p>`
    + `</section>`;
}

function renderRoundSwitcher(
  snapshot: StoryProgressSnapshot,
  selected: StoryProgressRound,
): string {
  const currentRoundId = snapshot.currentRoundId;
  const tabs = snapshot.rounds.map((round) => {
    const label = formatRoundLabel(round.round, currentRoundId);
    const selectedAttribute = round.round === selected.round ? ' aria-selected="true"' : ' aria-selected="false"';
    return `<a class="tab" role="tab" href="?round=${round.round}"${selectedAttribute}>${escapeHtml(label)}</a>`;
  }).join("");
  const history = snapshot.rounds
    .filter((round) => round.round !== currentRoundId)
    .map((round) => `<li><span class="round-entry">`
      + `<strong>${escapeHtml(formatRoundLabel(round.round, currentRoundId))}</strong>`
      + `<span class="meta">${escapeHtml(formatRoundTriggerLine(round))}</span>`
      + `<span class="money">${escapeHtml(formatRoundCostValue(round, currentRoundId))}</span>`
      + `</span></li>`)
    .join("");
  return `<section class="panel section" aria-labelledby="round-switcher-title">`
    + `<h2 id="round-switcher-title">${escapeHtml(STORY_PROGRESS_COPY.roundSwitcherHeading)}</h2>`
    + `<div class="tabs" role="tablist" aria-label="选择轮次">${tabs}</div>`
    + `<h2 class="subheading">${escapeHtml(STORY_PROGRESS_COPY.historyHeading)}</h2>`
    + `<ul class="round-list">${history}</ul>`
    + `</section>`;
}

function renderReadyBody(view: StoryProgressPageView, snapshot: StoryProgressSnapshot): string {
  const selected = selectedRoundOf(snapshot, view.selectedRoundId);
  if (selected === null) return "";
  const currentRoundId = snapshot.currentRoundId;
  const subtitle = `需求 ${snapshot.storyId}`;
  const reading = view.status === "loading"
    ? `<p class="read-state" role="status">${escapeHtml(STORY_PROGRESS_COPY.loading)}</p>`
    : "";
  return renderTitleBar(subtitle)
    + reading
    + renderRoundPanel(selected, currentRoundId, view.pendingResult)
    + renderCostPanel(snapshot, selected, currentRoundId)
    + renderBlockerPanel(selected)
    + renderRoundSwitcher(snapshot, selected);
}

function renderErrorBody(): string {
  return renderTitleBar(null)
    + `<div class="notice danger">`
    + `<p class="notice-message" role="alert">${escapeHtml(STORY_PROGRESS_COPY.failed)}</p>`
    + `<button type="button" onclick="window.location.reload()">${escapeHtml(STORY_PROGRESS_COPY.retry)}</button>`
    + `</div>`;
}

function renderEmptyBody(): string {
  return renderTitleBar(null)
    + `<div class="state-page"><div class="state-card">`
    + `<h2>${escapeHtml(STORY_PROGRESS_COPY.noRounds)}</h2>`
    + `<p>首轮开始后，这里会显示阶段、结果、卡点和费用。</p>`
    + `<a class="button secondary" href="/">${escapeHtml(STORY_PROGRESS_COPY.backToOverview)}</a>`
    + `</div></div>`;
}

/** The complete document for one requirement's detail page. */
export function renderStoryProgressPage(view: StoryProgressPageView): string {
  let body: string;
  if (view.status === "error") {
    body = renderErrorBody();
  } else if (view.status === "empty" || view.snapshot === null) {
    body = renderEmptyBody();
  } else {
    body = renderReadyBody(view, view.snapshot);
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>需求与任务详情｜Hivemind</title><style>${PAGE_STYLE}</style></head><body>`
    + `<div class="shell">${renderSidebar()}<main>${body}</main></div>`
    + renderMobileNavigation(view)
    + `</body></html>`;
}

/**
 * The one document route. It reads the same snapshot the JSON API reads and
 * maps every answer onto the page: a read that failed is the failure page, a
 * read with no round is the empty page, and `?state=` selects the whole-page
 * state a browser lane addresses.
 */
export function registerStoryProgressPageRoute(app: FastifyInstance, port: { readStoryProgress(storyId: string): Promise<StoryProgressReadResult> }): void {
  app.get(STORY_PROGRESS_PAGE_PATH, async (request, reply) => {
    const storyId = String((request.params as { storyId?: string }).storyId ?? "");
    const query = (request.query ?? {}) as StoryProgressPageQuery;
    const result = await port.readStoryProgress(storyId);
    return reply.type("text/html").send(renderStoryProgressPage(storyProgressPageView(result, query)));
  });
}
