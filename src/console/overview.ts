export interface OverviewItem {
  storyId?: string;
  id?: string;
  title: string;
  state: string;
  timestamp?: number;
  summary: string;
  taskPath: string;
}

export interface OverviewData {
  questions: OverviewItem[];
  active: OverviewItem[];
  events: OverviewItem[];
}

export interface OverviewGroup {
  title: string;
  items: OverviewItem[];
}

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
