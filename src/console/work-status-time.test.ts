import { describe, expect, it } from "vitest";
import { formatStartedWaiting, formatWaitingDuration } from "./work-status-time.js";

describe("work status waiting times", () => {
  // @scenario S-E1ACTION-02-duration
  it("shows the creation timestamp and elapsed hours and minutes", () => {
    expect(formatStartedWaiting(Date.UTC(2026, 8, 2, 10, 0))).toBe("2026-09-02 10:00");
    expect(formatWaitingDuration(125)).toBe("2 hours 5 minutes");
  });

  // @scenario S-E1ACTION-02-duration
  it("renders a non-empty zero duration instead of a negative duration", () => {
    expect(formatWaitingDuration(0)).toBe("0 minutes");
  });
});
