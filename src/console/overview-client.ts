const pad = (value: number): string => String(value).padStart(2, "0");

/** Formats the server's completed snapshot timestamp in the viewer's local timezone. */
export function formatSnapshotAt(snapshotAt: number): string {
  const date = new Date(snapshotAt);
  return `Overall status updated at ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
