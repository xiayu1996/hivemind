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

/** The scope text every amount is shown under, for example `按 UTC 自然日 · 美元`. */
export function formatDailyCostScope(_timeZone: string): string {
  return "";
}

/** Dollars to two decimals, for example `$3.50`. */
export function formatUsd(_costUsd: number): string {
  return "";
}

/**
 * Moves the page between its states. A selection starts a new request; a
 * response is only applied when it belongs to the newest request. A failed
 * read keeps the selection and drops the previous snapshot; an empty result
 * carries no days at all rather than a row of zeroes.
 */
export function reduceDailyCostView(
  _state: DailyCostViewState,
  _action: DailyCostViewAction,
): DailyCostViewState {
  return { status: "idle" };
}
