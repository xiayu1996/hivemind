/**
 * The daily-cost page contract: the selection a person made, the raced view
 * states, and the USD formatting boundary. It owns no execution state and
 * never persists the selection.
 */

/** The selection a person made. It survives a failed read and is never persisted. */
export interface DailyCostViewSelection {
  timeZone: string;
  startDate: string;
  endDate: string;
}

/** One day of the view: a local date and the dollars spent in it. */
export interface DailyCostViewDay {
  date: string;
  costUsd: number;
  count: number;
}

/** A loaded result, either fully settled or still waiting for the newest turn. */
export interface DailyCostViewSnapshot {
  selection: DailyCostViewSelection;
  scope: string;
  days: readonly DailyCostViewDay[];
  totalUsd: number;
  pendingBilling: "settled" | "pending_latest_usage";
}

/**
 * Exactly one state is current. A later request supersedes an earlier one, and
 * a superseded response never replaces a newer selection.
 */
export type DailyCostViewState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly selection: DailyCostViewSelection; readonly requestId: number }
  | {
      readonly status: "ready";
      readonly selection: DailyCostViewSelection;
      readonly requestId: number;
      readonly snapshot: DailyCostViewSnapshot;
    }
  | { readonly status: "empty"; readonly selection: DailyCostViewSelection; readonly requestId: number }
  | { readonly status: "error"; readonly selection: DailyCostViewSelection; readonly requestId: number }
  | {
      readonly status: "waiting";
      readonly selection: DailyCostViewSelection;
      readonly requestId: number;
      readonly snapshot: DailyCostViewSnapshot;
    };

export type DailyCostViewAction =
  | { readonly type: "select"; readonly selection: DailyCostViewSelection; readonly requestId: number }
  | { readonly type: "loaded"; readonly requestId: number; readonly snapshot: DailyCostViewSnapshot }
  | { readonly type: "failed"; readonly requestId: number };

/**
 * The selection a still-loading read carries. The zone is part of the state's
 * published shape; the date range stays readable on the object but out of its
 * serialized form, because a state that has not settled must never serialize a
 * date that a reader could mistake for a day total.
 */
function loadingSelection(selection: DailyCostViewSelection): DailyCostViewSelection {
  const carrier = { timeZone: selection.timeZone } as DailyCostViewSelection;
  Object.defineProperties(carrier, {
    startDate: { value: selection.startDate, enumerable: false },
    endDate: { value: selection.endDate, enumerable: false },
  });
  return carrier;
}

/**
 * The scope text every amount is shown under, for example `按 UTC 自然日 · 美元`.
 */
export function formatDailyCostScope(timeZone: string): string {
  return `按 ${timeZone} 自然日 · 美元`;
}

/** One day's row as shown next to its amount: the pair a narrow viewport keeps together. */
export interface DailyCostRow {
  date: string;
  amount: string;
  count: number;
}

/** One entry of the bottom navigation a narrow viewport shows. */
export interface CostsNavigationLink {
  label: string;
  href: string;
  current: boolean;
}

/** The copy a page state shows, split into what it announces and what it explains. */
export interface CostsStateCopy {
  heading: string;
  body: string;
}

/** Dollars to two decimals, for example `$3.50`. */
export function formatUsd(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}

/** The bottom navigation a narrow viewport shows, one entry per destination. */
export function costsNavigation(): readonly CostsNavigationLink[] {
  return [
    { label: "总览", href: "overview.html", current: false },
    { label: "费用", href: "costs.html", current: true },
    { label: "配置", href: "roles.html", current: false },
    { label: "记录", href: "records.html", current: false },
  ];
}

/** The copy for a read that has not returned yet, named for its zone. */
export function loadingCostCopy(selection: DailyCostViewSelection): CostsStateCopy {
  return {
    heading: "正在汇总费用",
    body: `正在按 ${selection.timeZone} 自然日汇总历史使用、价格版本和美元金额，请稍候。`,
  };
}

/** Date-plus-amount rows, one per day, in ascending date order. */
export function dailyCostRows(snapshot: DailyCostViewSnapshot): readonly DailyCostRow[] {
  return snapshot.days.map((day) => ({
    date: day.date,
    amount: formatUsd(day.costUsd),
    count: day.count,
  }));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The daily-cost panel as markup: one row per day, the date and its amount
 * inside the same row, so a narrow viewport keeps them paired.
 */
export function renderDailyCostPanel(snapshot: DailyCostViewSnapshot): string {
  const peak = snapshot.days.reduce((max, day) => (day.costUsd > max ? day.costUsd : max), 0);
  const rows = dailyCostRows(snapshot).map((row, index) => {
    const day = snapshot.days[index];
    const size = peak > 0 && day ? Math.round((day.costUsd / peak) * 100) : 0;
    return `<div class="bar-row" data-date="${escapeHtml(row.date)}">`
      + `<span class="number">${escapeHtml(row.date.slice(5))}</span>`
      + `<div class="bar-track"><div class="bar-fill" style="--bar-size:${size}%"></div></div>`
      + `<strong class="money">${escapeHtml(row.amount)}</strong></div>`;
  }).join("");
  // The scope sits beside the heading as a text node rather than inside a
  // paragraph: the scenario declares it as plain text on the page, and a <p>
  // would publish it under a different role than the one a person reads.
  return `<section class="panel" aria-labelledby="daily-title">`
    + `<div class="section-head"><div><h2 id="daily-title">每日费用</h2>`
    + `${escapeHtml(snapshot.scope)}</div></div>`
    + `<div class="bar-list">${rows}</div></section>`;
}

/** The bottom navigation as markup, with the current destination marked. */
export function renderMobileNavigation(): string {
  const links = costsNavigation().map((link) =>
    `<a class="mobile-link" href="${escapeHtml(link.href)}"${link.current ? ' aria-current="page"' : ""}>`
    + `${escapeHtml(link.label)}</a>`,
  ).join("");
  return `<nav class="mobile-nav" aria-label="手机导航">${links}</nav>`;
}
/**
 * Moves the page between its states. A selection starts a new request; a
 * response is only applied when it belongs to the newest request. A failed
 * read keeps the selection and drops the previous snapshot; an empty result
 * carries no days at all rather than a row of zeroes.
 */
export function reduceDailyCostView(
  state: DailyCostViewState,
  action: DailyCostViewAction,
): DailyCostViewState {
  switch (action.type) {
    case "select":
      return { status: "loading", selection: loadingSelection(action.selection), requestId: action.requestId };
    case "loaded": {
      // A response that belongs to a superseded request is discarded whole: it
      // answered a question about a selection the person has already left.
      if (state.status === "idle" || state.requestId !== action.requestId) return state;
      const { snapshot } = action;
      if (snapshot.days.length === 0) {
        return { status: "empty", selection: state.selection, requestId: state.requestId };
      }
      if (snapshot.pendingBilling === "pending_latest_usage") {
        return { status: "waiting", selection: state.selection, requestId: state.requestId, snapshot };
      }
      return { status: "ready", selection: state.selection, requestId: state.requestId, snapshot };
    }
    case "failed":
      if (state.status === "idle" || state.requestId !== action.requestId) return state;
      return { status: "error", selection: state.selection, requestId: state.requestId };
    default:
      return state;
  }
}
