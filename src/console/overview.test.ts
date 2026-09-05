import { describe, expect, it } from "vitest";
import { overviewGroups } from "./overview.js";

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
