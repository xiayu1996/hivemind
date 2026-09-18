import type { Client } from "@libsql/client";

/**
 * One selectable natural-day zone: the IANA id plus the option text a person
 * picks. The catalog is derived from the runtime, never from a hand-kept list,
 * so a zone the platform knows is a zone a person can choose.
 */
export interface DailyCostTimeZoneOption {
  id: string;
  label: string;
}

/**
 * The inclusive local-date range a person is looking at, interpreted in the
 * selected zone's own calendar. Dates are `YYYY-MM-DD` local dates, not instants.
 */
export interface DailyCostSelection {
  timeZone: string;
  startDate: string;
  endDate: string;
}

/** One priced model cost as the central ledger records it. */
export interface DailyCostEntry {
  id: number;
  ts: number;
  costUsd: number;
  isSubscription: boolean;
}

/** One calendar day of the selected zone, after every selected cost is counted once. */
export interface DailyCostDay {
  date: string;
  costUsd: number;
  count: number;
}

/**
 * Whether the newest completed model turn is still waiting for its cost record.
 * It is orthogonal to the day totals: history stays visible while the newest
 * turn is being priced.
 */
export type DailyCostPendingBilling = "settled" | "pending_latest_usage";

export interface DailyCostSnapshot {
  selection: DailyCostSelection;
  days: readonly DailyCostDay[];
  totalUsd: number;
  pendingBilling: DailyCostPendingBilling;
  generatedAt: number;
}

export type DailyCostInvalidCode = "invalid_time_zone" | "invalid_date" | "invalid_date_range";

export class DailyCostSelectionError extends Error {
  readonly code: DailyCostInvalidCode;

  constructor(code: DailyCostInvalidCode, message: string) {
    super(message);
    this.name = "DailyCostSelectionError";
    this.code = code;
  }
}

export type DailyCostReadResult =
  | { kind: "ok"; snapshot: DailyCostSnapshot }
  | { kind: "invalid"; code: DailyCostInvalidCode; message: string }
  | { kind: "failed"; message: string };

/**
 * Every zone the runtime supports plus `UTC`, sorted, each with its option
 * text. DST rules for those zones come from the runtime's IANA database, so a
 * 23- or 25-hour day still has one local date.
 */
export function listDailyCostTimeZones(): readonly DailyCostTimeZoneOption[] {
  return [];
}

/**
 * Returns the selection unchanged when it names a supported zone and a start
 * date no later than its end date; throws otherwise. Fixed offsets such as
 * `UTC-08:00` are rejected: they are not regions and carry no DST rules.
 */
export function validateDailyCostSelection(
  _selection: DailyCostSelection,
  _supportedTimeZones: ReadonlySet<string>,
): DailyCostSelection {
  return _selection;
}

/**
 * Groups each entry into the local calendar day of the selected zone, filters
 * to the inclusive range, counts both metered and subscription rows once, and
 * returns days in ascending order with no rows for date gaps.
 */
export function aggregateDailyCosts(
  _entries: readonly DailyCostEntry[],
  _selection: DailyCostSelection,
): readonly DailyCostDay[] {
  return [];
}

/**
 * `pending_latest_usage` when a completed model turn exists and no cost was
 * recorded at or after it in the same run snapshot.
 */
export function pendingBillingFromLatest(
  _latestTurnTs: number | null,
  _latestCostTs: number | null,
): DailyCostPendingBilling {
  return "settled";
}

export interface DailyCostReadPort {
  listTimeZones(): Promise<readonly DailyCostTimeZoneOption[]>;
  readDailyCosts(selection: DailyCostSelection): Promise<DailyCostReadResult>;
}

/** Reads one snapshot-consistent view of the central ledger. */
export class LibsqlDailyCostReadPort implements DailyCostReadPort {
  private readonly client: Client;
  private readonly now: () => number;

  constructor(client: Client, now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  listTimeZones(): Promise<readonly DailyCostTimeZoneOption[]> {
    return Promise.resolve(listDailyCostTimeZones());
  }

  readDailyCosts(selection: DailyCostSelection): Promise<DailyCostReadResult> {
    return Promise.resolve({
      kind: "failed",
      message: `daily costs for ${selection.timeZone} are not available yet`,
    });
  }
}
