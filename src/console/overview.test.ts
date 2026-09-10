import { describe, expect, it } from "vitest";
import { formatOverviewItem, formatRelativeTime, overviewGroups } from "./overview.js";

describe("S-E3OVERVIEW-01-active", () => {
  it("formats the latest activity time relative to the browser clock", () => {
    expect(formatRelativeTime(1_000, 181_000)).toBe("3 minutes ago");
    expect(formatRelativeTime(181_000, 181_000)).toBe("just now");
  });

  it("formats activity without exposing its internal state", () => {
    expect(formatOverviewItem({ title: "Implement dashboard", state: "CODE", summary: "Writing code", timestamp: 1_000, taskPath: "/tasks" }, 181_000))
      .toBe("Writing code · 3 minutes ago");
    expect(formatOverviewItem({ title: "New request", state: "QUEUED", summary: "Just created, not started yet", taskPath: "/tasks" }, 181_000))
      .toBe("Just created, not started yet");
  });
});

describe("S-E3OVERVIEW-01-questions", () => {
  it("formats a question without exposing its internal state", () => {
    expect(formatOverviewItem({ title: "Repository decision", state: "CLARIFY", summary: "Which repository should this use?", taskPath: "/tasks" }, 181_000))
      .toBe("Which repository should this use?");
  });
});

describe("S-E3OVERVIEW-01-delivery", () => {
  it("formats delivery without exposing its internal state", () => {
    expect(formatOverviewItem({ title: "Release dashboard", state: "DELIVERED", summary: "Delivered", timestamp: 1_000, taskPath: "/tasks" }, 181_000))
      .toBe("Delivered · 3 minutes ago");
  });
});

describe("S-E3OVERVIEW-01-failure", () => {
  it("formats a failure reason without exposing its internal state", () => {
    expect(formatOverviewItem({ title: "Deploy dashboard", state: "FAILED", summary: "Tests failed", timestamp: 1_000, taskPath: "/tasks" }, 181_000))
      .toBe("Tests failed · 3 minutes ago");
  });
});

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
  it("does not treat the final hour before a DST change as yesterday", () => {
    const now = new Date(2026, 2, 9, 12).getTime();
    const yesterday = new Date(2026, 2, 8, 12).getTime();
    const twoDaysAgo = new Date(2026, 2, 7, 23, 30).getTime();
    const groups = overviewGroups({ questions: [], active: [], events: [
      { storyId: "yesterday", title: "Yesterday", state: "FAILED", timestamp: yesterday, summary: "Failed", taskPath: "/tasks" },
      { storyId: "two-days-ago", title: "Two days ago", state: "FAILED", timestamp: twoDaysAgo, summary: "Failed", taskPath: "/tasks" },
    ] }, now);

    expect(groups[3]?.items.map((item) => item.storyId)).toEqual(["yesterday"]);
  });

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
