import { describe, expect, it } from "vitest";
import { overviewGroups } from "./overview.js";

describe("S-E3OVERVIEW-01-delivery", () => {
  it("does not treat the first half hour after a DST change as part of the prior day", () => {
    const now = new Date(2026, 2, 8, 12).getTime();
    const today = new Date(2026, 2, 8, 12).getTime();
    const nextDay = new Date(2026, 2, 9, 0, 30).getTime();
    const groups = overviewGroups({ questions: [], active: [], events: [
      { storyId: "today", title: "Today", state: "DELIVERED", timestamp: today, summary: "Delivered", taskPath: "/tasks" },
      { storyId: "next-day", title: "Next day", state: "DELIVERED", timestamp: nextDay, summary: "Delivered", taskPath: "/tasks" },
    ] }, now);

    expect(groups[2]?.items.map((item) => item.storyId)).toEqual(["today"]);
  });
});

describe("S-E3OVERVIEW-01-failure", () => {
  it("keeps only yesterday's failed events and preserves a failure reason", () => {
    const now = new Date(2026, 2, 12, 12).getTime();
    const yesterday = new Date(2026, 2, 11, 18).getTime();
    const today = new Date(2026, 2, 12, 8).getTime();
    const groups = overviewGroups({ questions: [], active: [], events: [
      { storyId: "failed", title: "Broken story", state: "FAILED", timestamp: yesterday, summary: "Build failed", taskPath: "/tasks" },
      { storyId: "today", title: "Today failure", state: "FAILED", timestamp: today, summary: "Ignored", taskPath: "/tasks" },
      { storyId: "delivery", title: "Delivered", state: "DELIVERED", timestamp: yesterday, summary: "Ignored", taskPath: "/tasks" },
      { storyId: "invalid", title: "Invalid", state: "FAILED", timestamp: Number.NaN, summary: "Ignored", taskPath: "/tasks" },
    ] }, now);

    expect(groups[3]?.items).toEqual([
      { storyId: "failed", title: "Broken story", state: "FAILED", timestamp: yesterday, summary: "Build failed", taskPath: "/tasks" },
    ]);
  });
});
