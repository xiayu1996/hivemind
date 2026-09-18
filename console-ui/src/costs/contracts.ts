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
  return [];
}

/** The copy for a read that has not returned yet, named for its zone. */
export function loadingCostCopy(_selection: DailyCostViewSelection): CostsStateCopy {
  return { heading: "", body: "" };
}

/** Date-plus-amount rows, one per day, in ascending date order. */
export function dailyCostRows(_snapshot: DailyCostViewSnapshot): readonly DailyCostRow[] {
  return [];
}

/** The daily-cost panel as markup: one row per day, date and amount together. */
export function renderDailyCostPanel(_snapshot: DailyCostViewSnapshot): string {
  return "";
}

/** The bottom navigation as markup, with the current destination marked. */
export function renderMobileNavigation(): string {
  return "";
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
