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

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * A fixed instant for reading a zone's standard offset. The catalog label is a
 * hint next to the id, so it must not drift with the moment the page is opened.
 */
const OFFSET_REFERENCE_MS = Date.UTC(2025, 0, 1);

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dateFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dateFormatters.set(timeZone, formatter);
  return formatter;
}

/** The zone-local calendar date an instant falls on, as `YYYY-MM-DD`. */
function localDateOf(ts: number, timeZone: string): string {
  const parts = dateFormatter(timeZone).formatToParts(new Date(ts));
  const part = (type: "year" | "month" | "day"): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A calendar-valid local date plus its parts, or null for anything else. */
function parseLocalDate(value: string): { year: number; month: number; day: number } | null {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/**
 * `UTC+8`, `UTC+5:30`, `UTC-5`: the zone's offset at the reference instant, in
 * the shape a person reads next to the id. Fixed offsets carried by a zone id
 * are the runtime's, never parsed from the text a caller passed in.
 */
function zoneOffsetLabel(id: string): string {
  if (id === "UTC") return "UTC+0";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: id, timeZoneName: "longOffset" })
    .formatToParts(new Date(OFFSET_REFERENCE_MS));
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!match) return "UTC+0";
  const [, sign, hours, minutes] = match;
  const hour = Number(hours);
  const minute = Number(minutes ?? "0");
  return `UTC${sign}${hour}${minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`}`;
}

/** Dollars rounded to the cent, so a sum is formatted from a settled number. */
function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Every zone the runtime supports plus `UTC`, sorted, each with its option
 * text. DST rules for those zones come from the runtime's IANA database, so a
 * 23- or 25-hour day still has one local date.
 */
export function listDailyCostTimeZones(): readonly DailyCostTimeZoneOption[] {
  return [...new Set([...Intl.supportedValuesOf("timeZone"), "UTC"])]
    .toSorted()
    .map((id) => ({ id, label: `${id} (${zoneOffsetLabel(id)})` }));
}

/**
 * Returns the selection unchanged when it names a supported zone and a start
 * date no later than its end date; throws otherwise. Fixed offsets such as
 * `UTC-08:00` are rejected: they are not regions and carry no DST rules.
 */
export function validateDailyCostSelection(
  selection: DailyCostSelection,
  supportedTimeZones: ReadonlySet<string>,
): DailyCostSelection {
  if (!supportedTimeZones.has(selection.timeZone)) {
    throw new DailyCostSelectionError(
      "invalid_time_zone",
      `the runtime does not know the time zone ${selection.timeZone}`,
    );
  }
  if (parseLocalDate(selection.startDate) === null) {
    throw new DailyCostSelectionError("invalid_date", `startDate is not a calendar date: ${selection.startDate}`);
  }
  if (parseLocalDate(selection.endDate) === null) {
    throw new DailyCostSelectionError("invalid_date", `endDate is not a calendar date: ${selection.endDate}`);
  }
  if (selection.startDate > selection.endDate) {
    throw new DailyCostSelectionError(
      "invalid_date_range",
      `startDate ${selection.startDate} is after endDate ${selection.endDate}`,
    );
  }
  return selection;
}

/**
 * Groups each entry into the local calendar day of the selected zone, filters
 * to the inclusive range, counts both metered and subscription rows once, and
 * returns days in ascending order with no rows for date gaps.
 */
export function aggregateDailyCosts(
  entries: readonly DailyCostEntry[],
  selection: DailyCostSelection,
): readonly DailyCostDay[] {
  const seen = new Set<number>();
  const days = new Map<string, DailyCostDay>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`the ledger holds cost entry ${entry.id} twice`);
    seen.add(entry.id);
    if (!Number.isFinite(entry.costUsd)) {
      throw new Error(`cost entry ${entry.id} carries a non-finite amount`);
    }
    const date = localDateOf(entry.ts, selection.timeZone);
    if (date < selection.startDate || date > selection.endDate) continue;
    const current = days.get(date) ?? { date, costUsd: 0, count: 0 };
    current.costUsd += entry.costUsd;
    current.count += 1;
    days.set(date, current);
  }
  return [...days.values()]
    .map((day) => ({ date: day.date, costUsd: roundUsd(day.costUsd), count: day.count }))
    .toSorted((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * `pending_latest_usage` when a completed model turn exists and no cost was
 * recorded at or after it in the same run snapshot.
 */
export function pendingBillingFromLatest(
  latestTurnTs: number | null,
  latestCostTs: number | null,
): DailyCostPendingBilling {
  if (latestTurnTs === null) return "settled";
  if (latestCostTs !== null && latestCostTs >= latestTurnTs) return "settled";
  return "pending_latest_usage";
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

  async readDailyCosts(selection: DailyCostSelection): Promise<DailyCostReadResult> {
    const supported = new Set(listDailyCostTimeZones().map((zone) => zone.id));
    try {
      validateDailyCostSelection(selection, supported);
    } catch (cause) {
      if (cause instanceof DailyCostSelectionError) {
        return { kind: "invalid", code: cause.code, message: cause.message };
      }
      return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
    }

    try {
      const costRows = (await this.client.execute(
        "SELECT id, ts, cost_usd, is_subscription FROM cost_entries ORDER BY ts",
      )).rows;
      const turnRows = (await this.client.execute("SELECT ts FROM turn_usage ORDER BY ts")).rows;

      const entries: DailyCostEntry[] = costRows.map((row) => ({
        id: Number(row.id),
        ts: Number(row.ts),
        costUsd: Number(row.cost_usd),
        isSubscription: Number(row.is_subscription) === 1,
      }));
      const days = aggregateDailyCosts(entries, selection);

      const inRange = (ts: number): boolean => {
        const date = localDateOf(ts, selection.timeZone);
        return date >= selection.startDate && date <= selection.endDate;
      };
      let latestCostTs: number | null = null;
      for (const entry of entries) {
        if (!inRange(entry.ts)) continue;
        if (latestCostTs === null || entry.ts > latestCostTs) latestCostTs = entry.ts;
      }
      let latestTurnTs: number | null = null;
      for (const row of turnRows) {
        const ts = Number(row.ts);
        if (!inRange(ts)) continue;
        if (latestTurnTs === null || ts > latestTurnTs) latestTurnTs = ts;
      }

      const totalUsd = roundUsd(days.reduce((sum, day) => sum + day.costUsd, 0));
      return {
        kind: "ok",
        snapshot: {
          selection,
          days,
          totalUsd,
          pendingBilling: pendingBillingFromLatest(latestTurnTs, latestCostTs),
          generatedAt: this.now(),
        },
      };
    } catch (cause) {
      return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
