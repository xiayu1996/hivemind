import { describe, expect, it } from "vitest";
import { formatSnapshotAt, hasCompleteOverview, hasFreshSnapshot, primarySections } from "./overview-client.js";

describe("S-E3OVERVIEW-03-timestamp", () => {
  it("formats the completed overview snapshot in the browser's local time", () => {
    expect(formatSnapshotAt(new Date(2026, 2, 15, 12, 3).getTime()))
      .toBe("Overall status updated at 2026-03-15 12:03");
  });
});

describe("S-E3OVERVIEW-03-performance", () => {
  it("puts the answer and active-work regions in the first paint", () => {
    expect(primarySections([
      { title: "Waiting for your answer" },
      { title: "Active work" },
      { title: "Delivered today" },
    ]).map((section) => section.title)).toEqual(["Waiting for your answer", "Active work"]);
  });
});

describe("S-E3OVERVIEW-03-sections", () => {
  it("renders five status regions only from a complete overview payload", () => {
    expect(hasCompleteOverview({ questions: [], active: [], events: [], costs: [] })).toBe(true);
    expect(hasCompleteOverview({ questions: [], active: [], events: [] })).toBe(false);
  });
});

describe("S-E3OVERVIEW-03-freshness", () => {
  const now = new Date(2026, 2, 15, 12).getTime();

  it("accepts only completed snapshots no more than five minutes old and never from the future", () => {
    expect(hasFreshSnapshot({ snapshotAt: now - 5 * 60_000 }, now)).toBe(true);
    expect(hasFreshSnapshot({ snapshotAt: now - 5 * 60_000 - 1 }, now)).toBe(false);
    expect(hasFreshSnapshot({ snapshotAt: now + 1 }, now)).toBe(false);
    expect(hasFreshSnapshot({ snapshotAt: "not-a-time" }, now)).toBe(false);
    expect(hasFreshSnapshot({}, now)).toBe(false);
  });
});
