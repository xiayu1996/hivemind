const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

const pad = (value: number): string => String(value).padStart(2, "0");

/** Formats the server's completed snapshot timestamp in the viewer's local timezone. */
export function formatSnapshotAt(snapshotAt: number): string {
  const date = new Date(snapshotAt);
  return `Overall status updated at ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A complete response has enough data to render every fixed home-page region. */
export function hasCompleteOverview(value: unknown): value is { questions: unknown[]; active: unknown[]; events: unknown[]; costs: unknown[] } {
  return typeof value === "object" && value !== null
    && Array.isArray((value as { questions?: unknown }).questions)
    && Array.isArray((value as { active?: unknown }).active)
    && Array.isArray((value as { events?: unknown }).events)
    && Array.isArray((value as { costs?: unknown }).costs);
}

/** A client may render only a complete snapshot produced within the last five minutes. */
export function hasFreshSnapshot(value: { snapshotAt?: unknown }, now = Date.now()): value is { snapshotAt: number } {
  return typeof value.snapshotAt === "number"
    && Number.isFinite(value.snapshotAt)
    && value.snapshotAt >= now - SNAPSHOT_MAX_AGE_MS
    && value.snapshotAt <= now;
}

/** The two attention regions are intentionally painted before historical summaries. */
export function primarySections<T>(sections: readonly T[]): T[] {
  return sections.slice(0, 2);
}

export { SNAPSHOT_MAX_AGE_MS };
