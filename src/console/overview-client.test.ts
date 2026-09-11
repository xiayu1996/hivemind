import { describe, expect, it } from "vitest";
import { formatSnapshotAt } from "./overview-client.js";

describe("S-E3OVERVIEW-03-timestamp", () => {
  it("formats the completed overview snapshot in the browser's local time", () => {
    expect(formatSnapshotAt(new Date(2026, 2, 15, 12, 3).getTime()))
      .toBe("Overall status updated at 2026-03-15 12:03");
  });
});
