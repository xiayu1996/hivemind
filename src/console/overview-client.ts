const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

const pad = (value: number): string => String(value).padStart(2, "0");

/** Formats the server's completed snapshot timestamp in the viewer's local timezone. */
export function formatSnapshotAt(snapshotAt: number): string {
  const date = new Date(snapshotAt);
  return `Overall status updated at ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A client may render only a complete snapshot produced within the last five minutes. */
export function hasFreshSnapshot(value: { snapshotAt?: unknown }, now = Date.now()): value is { snapshotAt: number } {
  return typeof value.snapshotAt === "number"
    && Number.isFinite(value.snapshotAt)
    && value.snapshotAt >= now - SNAPSHOT_MAX_AGE_MS
    && value.snapshotAt <= now;
}

export { SNAPSHOT_MAX_AGE_MS };
