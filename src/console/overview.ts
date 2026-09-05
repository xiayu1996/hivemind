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

function happenedOn(item: OverviewItem, start: number): boolean {
  return Number.isFinite(item.timestamp)
    && item.timestamp! >= start && item.timestamp! < start + 86_400_000;
}

/** Calendar boundaries belong to the browser, where the user's local timezone is known. */
export function overviewGroups(data: OverviewData, now = Date.now()): OverviewGroup[] {
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const yesterday = today - 86_400_000;
  return [
    { title: "Waiting for your answer", items: data.questions },
    { title: "Active work", items: data.active },
    { title: "Delivered today", items: data.events.filter((item) => item.state === "DELIVERED" && happenedOn(item, today)) },
    { title: "Failed yesterday", items: data.events.filter((item) => item.state === "FAILED" && happenedOn(item, yesterday)) },
  ];
}
