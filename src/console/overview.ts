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
