export interface OverviewItem {
  storyId?: string;
  id?: string;
  title: string;
  state: string;
  timestamp?: number;
  summary: string;
  taskPath: string;
}

/** One cost_entries row, already reduced to the fields the cost region reads. */
export interface CostEntry {
  ts: number;
  modelId?: string | null;
  costUsd: number;
}

export interface OverviewData {
  questions: OverviewItem[];
  active: OverviewItem[];
  events: OverviewItem[];
  costs?: CostEntry[];
}

export interface OverviewGroup {
  title: string;
  items: OverviewItem[];
}

export interface CostModelRow {
  modelId: string;
  text: string;
}

export interface CostBar {
  dateLabel: string;
  amountLabel: string;
  heightPercent: number;
}

/** The cost region: the only section on the home page that carries numbers. */
export interface CostSection {
  kind: "cost";
  title: string;
  todayLabel: string;
  monthLabel: string;
  updatedLabel: string;
  chart: CostBar[];
  models: CostModelRow[];
}

export type OverviewSection =
  | { kind: "group"; title: string; items: OverviewItem[] }
  | CostSection;

const COST_CHART_DAYS = 7;

export function formatOverviewItem(item: OverviewItem, now = Date.now()): string {
  return Number.isFinite(item.timestamp)
    ? `${item.summary} · ${formatRelativeTime(item.timestamp!, now)}`
    : item.summary;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Local MM-DD for a chart bar, zero padded so the labels line up. */
function formatMonthDay(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** A record is usable only with a finite non-negative cost and a real timestamp. */
function isUsableCost(entry: CostEntry): boolean {
  return Number.isFinite(entry.costUsd) && entry.costUsd >= 0 && Number.isFinite(entry.ts);
}

function sumBetween(entries: readonly CostEntry[], start: number, end: number): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.ts >= start && entry.ts < end) total += entry.costUsd;
  }
  return total;
}

/** A record without a model id still counts toward the totals, but has no row of its own. */
function modelRows(
  entries: readonly CostEntry[],
  todayStart: number,
  tomorrowStart: number,
  monthStart: number,
  nextMonthStart: number,
): CostModelRow[] {
  const byModel = new Map<string, { today: number; month: number }>();
  for (const entry of entries) {
    const modelId = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
    if (modelId === "") continue;
    const bucket = byModel.get(modelId) ?? { today: 0, month: 0 };
    if (entry.ts >= todayStart && entry.ts < tomorrowStart) bucket.today += entry.costUsd;
    if (entry.ts >= monthStart && entry.ts < nextMonthStart) bucket.month += entry.costUsd;
    byModel.set(modelId, bucket);
  }
  return [...byModel.entries()]
    .filter(([, bucket]) => bucket.month > 0)
    .toSorted((a, b) => b[1].month - a[1].month || a[0].localeCompare(b[0]))
    .map(([modelId, bucket]) => ({
      modelId,
      text: `${modelId} \u00b7 Today ${formatUsd(bucket.today)} \u00b7 This month ${formatUsd(bucket.month)}`,
    }));
}

/**
 * The cost region is the last section, after the four recent-result groups.
 * Calendar boundaries stay in the browser, so the same payload rolls over
 * correctly for whoever is looking at it.
 */
export function costSection(data: OverviewData, now = Date.now()): CostSection {
  const entries = (data.costs ?? []).filter(isUsableCost);
  const current = new Date(now);
  const dayDate = (offset: number) => new Date(current.getFullYear(), current.getMonth(), current.getDate() + offset);
  const todayStart = dayDate(0).getTime();
  const tomorrowStart = dayDate(1).getTime();
  const monthStart = new Date(current.getFullYear(), current.getMonth(), 1).getTime();
  const nextMonthStart = new Date(current.getFullYear(), current.getMonth() + 1, 1).getTime();

  const todayTotal = sumBetween(entries, todayStart, tomorrowStart);
  const monthTotal = sumBetween(entries, monthStart, nextMonthStart);
  const latest = entries.reduce<number | null>((newest, entry) => (newest === null || entry.ts > newest ? entry.ts : newest), null);

  const daily = Array.from({ length: COST_CHART_DAYS }, (_unused, index) => {
    const offset = index - (COST_CHART_DAYS - 1);
    return {
      dateLabel: formatMonthDay(dayDate(offset)),
      total: sumBetween(entries, dayDate(offset).getTime(), dayDate(offset + 1).getTime()),
    };
  });
  const peak = daily.reduce((highest, day) => Math.max(highest, day.total), 0);

  return {
    kind: "cost",
    title: "Approximate costs",
    todayLabel: `Today ${formatUsd(todayTotal)}`,
    monthLabel: `This month ${formatUsd(monthTotal)}`,
    updatedLabel: latest === null ? "" : `Updated ${formatRelativeTime(latest, now)}`,
    chart: daily.map((day) => ({
      dateLabel: day.dateLabel,
      amountLabel: formatUsd(day.total),
      heightPercent: peak > 0 ? (day.total / peak) * 100 : 0,
    })),
    models: modelRows(entries, todayStart, tomorrowStart, monthStart, nextMonthStart),
  };
}

/** The home page as one ordered list: four result groups, then the cost region. */
export function overviewSections(data: OverviewData, now = Date.now()): OverviewSection[] {
  return [
    ...overviewGroups(data, now).map((group): OverviewSection => ({ kind: "group", title: group.title, items: group.items })),
    costSection(data, now),
  ];
}

function happenedOn(item: OverviewItem, start: number, end: number): boolean {
  return Number.isFinite(item.timestamp)
    && item.timestamp! >= start && item.timestamp! < end;
}

/** Calendar boundaries belong to the browser, where the user's local timezone is known. */
export function overviewGroups(data: OverviewData, now = Date.now()): OverviewGroup[] {
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return [
    { title: "Waiting for your answer", items: data.questions },
    { title: "Active work", items: data.active },
    { title: "Delivered today", items: data.events.filter((item) => item.state === "DELIVERED" && happenedOn(item, today.getTime(), tomorrow.getTime())) },
    { title: "Failed yesterday", items: data.events.filter((item) => item.state === "FAILED" && happenedOn(item, yesterday.getTime(), today.getTime())) },
  ];
}
