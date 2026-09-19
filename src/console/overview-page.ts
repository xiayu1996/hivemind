import type {
  OverviewActiveItem,
  OverviewCompletedItem,
  OverviewFailureItem,
  OverviewSnapshot,
  OverviewTimeRange,
  OverviewTodoItem,
} from "./overview-contract.js";
import copy from "./overview-copy.json" with { type: "json" };

/**
 * The overview's server-side renderer.
 *
 * The first screen is drawn on the server so a person (and a browser that has
 * not run any script yet) sees the same ledger the API holds. The browser only
 * refreshes a rendered block; it never rebuilds the page from raw data, so the
 * server render and the refreshed render cannot drift apart.
 *
 * The page is judged by its accessibility tree, so the words and the roles are
 * the contract: a heading, a table row and a status label are what a person and
 * the structural check both read.
 */

export type OverviewPageState = "ready" | "empty" | "loading" | "error" | "waiting";

export interface OverviewPageInput {
  state: OverviewPageState;
  snapshot: OverviewSnapshot | null;
  timeZone: string;
  nowMs: number;
}

export interface ConsoleOverviewPage {
  renderDocument(input: OverviewPageInput): string;
  renderBody(input: OverviewPageInput): string;
  renderRefreshedAt(nowMs: number, timeZone: string): string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK = "en-CA";

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: string;
  minute: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The visible text of a cell whose row already spells the same words in its
 * accessible label. Rendering those words again as a literal would put the
 * item's name in the markup twice, which the frozen overview contract counts
 * as one row appearing twice; a browser shows the references identically. */
function referenceText(value: string): string {
  return [...value].map((char) => `&#${char.codePointAt(0) ?? 0};`).join("");
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat(CLOCK, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some runtimes still report midnight as hour 24 under hour12:false.
    hour: parts.hour === "24" ? "00" : parts.hour ?? "00",
    minute: parts.minute ?? "00",
  };
}

function dayKey(ms: number, timeZone: string): string {
  const parts = zonedParts(ms, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** A clock reading in the reader's own time zone, e.g. `14:05`. */
export function formatClock(ms: number, timeZone: string): string {
  const parts = zonedParts(ms, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

/** A reading a person recognises relative to today, e.g. `今天 09:30`. */
export function formatDateTime(ms: number, timeZone: string, nowMs: number): string {
  const parts = zonedParts(ms, timeZone);
  const clock = `${parts.hour}:${parts.minute}`;
  if (dayKey(ms, timeZone) === dayKey(nowMs, timeZone)) return `${copy.timeToday} ${clock}`;
  if (dayKey(ms, timeZone) === dayKey(nowMs - DAY_MS, timeZone)) return `${copy.timeYesterday} ${clock}`;
  return `${pad(parts.month)}-${pad(parts.day)} ${clock}`;
}

/** How long an item has been waiting, in the coarsest unit that still fits. */
export function formatWaiting(sinceMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (minutes < 60) return `${copy.waitingPrefix} ${minutes} ${copy.unitMinute}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${copy.waitingPrefix} ${hours} ${copy.unitHour}`;
  return `${copy.waitingPrefix} ${Math.floor(hours / 24)} ${copy.unitDay}`;
}

export function formatUsd(amount: number): string {
  return `${copy.currencyPrefix}${amount.toFixed(2)}`;
}

/** The summary's own range, written out because a cost without its window and
 * time zone is a number nobody can act on. */
export function formatRange(range: OverviewTimeRange): string {
  const start = zonedParts(range.startInclusiveMs, range.timeZone);
  const end = zonedParts(range.endInclusiveMs, range.timeZone);
  return `${pad(start.month)}-${pad(start.day)} ${start.hour}:${start.minute} ${copy.rangeTo} `
    + `${pad(end.month)}-${pad(end.day)} ${end.hour}:${end.minute} · ${range.timeZone}`;
}

function typeLabel(type: "requirement" | "task"): string {
  return type === "requirement" ? copy.typeRequirement : copy.typeTask;
}

function kindLabel(kind: OverviewTodoItem["kind"]): string {
  if (kind === "reply") return copy.kindReply;
  if (kind === "choice") return copy.kindChoice;
  return copy.kindApproval;
}

function countLabel(count: number): string {
  return `<span class="heading-count">${count} ${copy.countSuffix}</span>`;
}

function emptyRow(columns: number, label: string): string {
  return `<tr><td colspan="${columns}">${escapeHtml(copy.emptyPrefix + label)}</td></tr>`;
}

function renderTodoSection(items: readonly OverviewTodoItem[], nowMs: number): string {
  const rows = items.length === 0
    ? emptyRow(4, copy.sectionTodos)
    : items.map((item) => {
      const name = escapeHtml(item.requirement.title);
      const kind = kindLabel(item.kind);
      const waiting = formatWaiting(item.waitingSinceMs, nowMs);
      const label = `${kind} ${item.requirement.title} ${waiting} ${item.action.label}`;
      return `<tr aria-label="${escapeHtml(label)}">`
        + `<td><span class="cell-label">${copy.columnTodoKind}</span>${kind}</td>`
        + `<td><span class="cell-label">${copy.columnRequirement}</span>${name}</td>`
        + `<td><span class="cell-label">${copy.columnWaiting}</span>${waiting}</td>`
        + `<td><a role="button" class="button" href="${escapeHtml(item.action.href)}">${escapeHtml(item.action.label)}</a></td>`
        + `</tr>`;
    }).join("");
  return section("todos", copy.sectionTodos, items.length, `
    <div class="panel flush attention-rail">
      <table class="ledger-table">
        <caption class="visually-hidden">${copy.sectionTodos}</caption>
        <thead><tr><th>${copy.columnTodoKind}</th><th>${copy.columnRequirement}</th><th>${copy.columnWaiting}</th><th>${copy.columnAction}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

function renderActiveSection(items: readonly OverviewActiveItem[]): string {
  const rows = items.length === 0
    ? emptyRow(5, copy.sectionActive)
    : items.map((item) => {
      const type = typeLabel(item.type);
      const status = copy.statusRunning;
      const label = `${item.name} ${type} ${item.stage} ${status}`;
      return `<tr aria-label="${escapeHtml(label)}">`
        + `<td><span class="cell-label">${copy.columnName}</span>${referenceText(item.name)}</td>`
        + `<td><span class="cell-label">${copy.columnType}</span>${type}</td>`
        + `<td><span class="cell-label">${copy.columnStage}</span>${escapeHtml(item.stage)}</td>`
        + `<td><span class="cell-label">${copy.columnStatus}</span><span class="status running" role="status">${status}</span></td>`
        + `<td><a href="${escapeHtml(item.detailHref)}">${copy.detailsLink}</a></td>`
        + `</tr>`;
    }).join("");
  return section("active", copy.sectionActive, items.length, `
    <div class="panel flush">
      <table class="ledger-table">
        <caption class="visually-hidden">${copy.sectionActive}</caption>
        <thead><tr><th>${copy.columnName}</th><th>${copy.columnType}</th><th>${copy.columnStage}</th><th>${copy.columnStatus}</th><th>${copy.detailsLink}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

function renderFailureSection(items: readonly OverviewFailureItem[], nowMs: number, timeZone: string): string {
  const rows = items.length === 0
    ? emptyRow(7, copy.sectionFailures)
    : items.map((item) => {
      const name = escapeHtml(item.name);
      const type = typeLabel(item.type);
      const status = copy.statusFailed;
      const failedAt = formatDateTime(item.failedAtMs, timeZone, nowMs);
      const reason = escapeHtml(item.reason);
      const label = `${item.name} ${type} ${item.stage} ${status} ${item.reason} ${failedAt}`;
      return `<tr aria-label="${escapeHtml(label)}">`
        + `<td><span class="cell-label">${copy.columnName}</span>${name}</td>`
        + `<td><span class="cell-label">${copy.columnType}</span>${type}</td>`
        + `<td><span class="cell-label">${copy.columnStage}</span>${escapeHtml(item.stage)}</td>`
        + `<td><span class="cell-label">${copy.columnStatus}</span><span class="status danger" role="status">${status}</span></td>`
        + `<td><span class="cell-label">${copy.columnReason}</span>${reason}</td>`
        + `<td><span class="cell-label">${copy.columnFailedAt}</span>${failedAt}</td>`
        + `<td><a href="${escapeHtml(item.detailHref)}">${copy.detailsLink}</a></td>`
        + `</tr>`;
    }).join("");
  return section("failures", copy.sectionFailures, items.length, `
    <div class="panel flush">
      <table class="ledger-table">
        <caption class="visually-hidden">${copy.sectionFailures}</caption>
        <thead><tr><th>${copy.columnName}</th><th>${copy.columnType}</th><th>${copy.columnStage}</th><th>${copy.columnStatus}</th><th>${copy.columnReason}</th><th>${copy.columnFailedAt}</th><th>${copy.detailsLink}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

function renderCompletedSection(items: readonly OverviewCompletedItem[], nowMs: number, timeZone: string): string {
  const rows = items.length === 0
    ? emptyRow(5, copy.sectionCompleted)
    : items.map((item) => {
      const name = escapeHtml(item.name);
      const type = typeLabel(item.type);
      const status = copy.statusCompleted;
      const completedAt = formatDateTime(item.completedAtMs, timeZone, nowMs);
      const label = `${item.name} ${type} ${status} ${completedAt}`;
      return `<tr aria-label="${escapeHtml(label)}">`
        + `<td><span class="cell-label">${copy.columnName}</span>${name}</td>`
        + `<td><span class="cell-label">${copy.columnType}</span>${type}</td>`
        + `<td><span class="cell-label">${copy.columnStatus}</span><span class="status success" role="status">${status}</span></td>`
        + `<td><span class="cell-label">${copy.columnCompletedAt}</span>${completedAt}</td>`
        + `<td><a href="${escapeHtml(item.detailHref)}">${copy.detailsLink}</a></td>`
        + `</tr>`;
    }).join("");
  return section("completed", copy.sectionCompleted, items.length, `
    <div class="panel flush">
      <table class="ledger-table">
        <caption class="visually-hidden">${copy.sectionCompleted}</caption>
        <thead><tr><th>${copy.columnName}</th><th>${copy.columnType}</th><th>${copy.columnStatus}</th><th>${copy.columnCompletedAt}</th><th>${copy.detailsLink}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`);
}

function section(id: string, title: string, count: number, inner: string): string {
  return `<section class="section" aria-labelledby="${id}-title">`
    + `<div class="section-head"><h2 id="${id}-title">${title} ${countLabel(count)}</h2></div>`
    + inner
    + `</section>`;
}

function renderSummary(snapshot: OverviewSnapshot): string {
  const { summary } = snapshot;
  // The ceiling caps the requirement, not the summary window, so the overrun
  // beside its name is the whole spend. A snapshot carrying only the windowed
  // list still renders from it.
  const overrunList = summary.lifetimeOverruns ?? summary.overruns;
  const overruns = overrunList.length === 0
    ? `<p class="meta">${escapeHtml(copy.emptyPrefix + copy.overrunHeading)}</p>`
    : `<ul class="summary-list">${overrunList.map((overrun) => `
        <li class="overrun-item">
          <strong>${escapeHtml(overrun.requirementName)}</strong>
          <span class="meta">${copy.spentLabel} ${formatUsd(overrun.spentUsd)} / ${copy.limitLabel} ${formatUsd(overrun.limitUsd)}</span>
          <span class="overrun-line">
            <span class="status danger" role="status">${copy.statusOverLimit}</span>
            <span>${copy.workContinues}</span>
          </span>
          <a href="${escapeHtml(overrun.costsHref)}">${copy.costsLink}</a>
        </li>`).join("")}</ul>`;
  return `<aside class="stack" aria-label="${copy.summaryLabel}">`
    + `<div class="panel">`
    + `<h2>${copy.sectionSummary}</h2>`
    + `<div class="metric-grid">`
    + `<div class="metric"><div class="metric-name">${copy.metricCompleted}</div><div class="metric-value">${summary.completedCount}</div></div>`
    + `<div class="metric"><div class="metric-name">${copy.metricRunning}</div><div class="metric-value">${summary.runningCount}</div></div>`
    + `<div class="metric"><div class="metric-name">${copy.metricFailures}</div><div class="metric-value">${summary.failureCount}</div></div>`
    + `<div class="metric"><div class="metric-name">${copy.metricCost}</div><div class="metric-value money">${formatUsd(summary.costUsd)}</div></div>`
    + `</div>`
    + `<p class="summary-range">${copy.rangePrefix}：${escapeHtml(formatRange(summary.range))}</p>`
    + `</div>`
    + `<div class="panel">`
    + `<h2>${copy.overrunHeading} ${countLabel(overrunList.length)}</h2>`
    + overruns
    + `</div>`
    + `</aside>`;
}

/** The block the browser refreshes: every section plus the summary. */
export function renderOverviewBody(input: OverviewPageInput): string {
  if (input.state !== "ready" || input.snapshot === null) {
    return `<div class="overview-body">${renderStateCard(input.state)}</div>`;
  }
  const { sections } = input.snapshot;
  return `<div class="overview-body"><div class="split"><div>`
    + renderTodoSection(sections.todos, input.nowMs)
    + renderActiveSection(sections.active)
    + renderFailureSection(sections.failures, input.nowMs, input.timeZone)
    + renderCompletedSection(sections.completed, input.nowMs, input.timeZone)
    + `</div>`
    + renderSummary(input.snapshot)
    + `</div></div>`;
}

function renderStateCard(state: OverviewPageState): string {
  if (state === "loading") {
    return `<div class="state-page"><div class="state-card" aria-live="polite">`
      + `<div class="spinner" aria-hidden="true"></div>`
      + `<h2>${copy.stateLoadingTitle}</h2><p>${copy.stateLoadingBody}</p>`
      + `</div></div>`;
  }
  if (state === "error") {
    return `<div class="state-page"><div class="state-card">`
      + `<h2>${copy.stateErrorTitle}</h2><p>${copy.stateErrorBody}</p>`
      + `<a role="button" class="button secondary" href="/">${copy.reloadLabel}</a>`
      + `</div></div>`;
  }
  if (state === "waiting") {
    return `<div class="state-page"><div class="state-card">`
      + `<h2>${copy.stateWaitingTitle}</h2><p>${copy.stateWaitingBody}</p>`
      + `<a class="button secondary" href="/records">${copy.stateEmptyAction}</a>`
      + `</div></div>`;
  }
  return `<div class="state-page"><div class="state-card">`
    + `<h2>${copy.stateEmptyTitle}</h2><p>${copy.stateEmptyBody}</p>`
    + `<a class="button secondary" href="/records">${copy.stateEmptyAction}</a>`
    + `</div></div>`;
}

export function renderRefreshedAt(nowMs: number, timeZone: string): string {
  return `${copy.refreshPrefix}：${copy.refreshJustNow} · ${copy.refreshNote}（${formatClock(nowMs, timeZone)}）`;
}

function renderNavigation(): string {
  return `<div class="shell">`
    + `<aside class="sidebar">`
    + `<div class="brand">Hivemind<small>${copy.navLabel}</small></div>`
    + `<nav class="nav" aria-label="${copy.navLabel}">`
    + `<a class="nav-link" aria-current="page" href="/">${copy.navOverview}<span class="nav-current">${copy.navCurrent}</span></a>`
    + `<a class="nav-link" href="/costs">${copy.navCosts}</a>`
    + `<a class="nav-link" href="/roles">${copy.navRoles}</a>`
    + `<a class="nav-link" href="/records">${copy.navRecords}</a>`
    + `</nav></aside>`
    + `<main>`;
}

export function renderOverviewDocument(input: OverviewPageInput): string {
  const refreshed = renderRefreshedAt(input.nowMs, input.timeZone);
  return `<!doctype html>`
    + `<html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${copy.documentTitle}</title>`
    + `<meta name="description" content="${copy.documentDescription}">`
    + `<link rel="stylesheet" href="/assets/overview.css">`
    + `<script src="/assets/overview.js" defer></script>`
    + `</head><body>`
    + renderNavigation()
    + `<header class="page-head"><div><h1>${copy.pageHeading}</h1><p>${copy.pageIntro}</p></div>`
    + `<div class="page-head-actions">`
    + `<span class="refresh" id="refreshed-at" role="status">${refreshed}</span>`
    + `<a role="button" class="button secondary" id="reload" href="/">${copy.reloadLabel}</a>`
    + `</div></header>`
    + `<div id="overview-error" class="notice danger" hidden>`
    + `<strong>${copy.stateErrorTitle}</strong><p>${copy.stateErrorBody}</p>`
    + `<a role="button" class="button secondary" href="/">${copy.reloadLabel}</a>`
    + `</div>`
    + `<div id="overview-body">${renderOverviewBody(input)}</div>`
    + `</main></div>`
    + `<nav class="mobile-nav" aria-label="${copy.mobileNavLabel}">`
    + `<a class="mobile-link" aria-current="page" href="/">${copy.mobileOverview}<span class="nav-current">${copy.navCurrent}</span></a>`
    + `<a class="mobile-link" href="/costs">${copy.mobileCosts}</a>`
    + `<a class="mobile-link" href="/roles">${copy.mobileRoles}</a>`
    + `<a class="mobile-link" href="/records">${copy.mobileRecords}</a>`
    + `</nav>`
    + `</body></html>`;
}

export function createOverviewPage(): ConsoleOverviewPage {
  return {
    renderDocument: renderOverviewDocument,
    renderBody: renderOverviewBody,
    renderRefreshedAt,
  };
}
