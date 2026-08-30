import { describe, expect, it } from "vitest";
import { isUsageLimit, parseUsageLimit, usageLimitAction } from "./usage-limit.js";

const NOW = 1_700_000_000_000;

/** Rebuilds the message from pi 0.84.3's own template so the cases cannot drift. */
function build(planType: string | null, resetsAtSeconds: number | null, atMs: number): string {
  const plan = planType ? ` (${planType.toLowerCase()} plan)` : "";
  const minutes = resetsAtSeconds ? Math.max(0, Math.round((resetsAtSeconds * 1000 - atMs) / 60_000)) : undefined;
  const when = minutes === undefined ? "" : ` Try again in ~${minutes} min.`;
  return `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
}

describe("parseUsageLimit", () => {
  it("reads the plan and the window from the message pi actually emits", () => {
    const message = build("Plus", (NOW + 47 * 60_000) / 1000, NOW);
    expect(message).toBe("You have hit your ChatGPT usage limit (plus plan). Try again in ~47 min.");
    expect(parseUsageLimit(message, NOW)).toEqual({
      plan: "plus",
      resetMinutes: 47,
      resetAt: NOW + 47 * 60_000,
    });
  });

  it("anchors the window to the event's own time, not to when it was read", () => {
    // The event sat in a backlog for twenty minutes before anyone looked at it.
    const eventTime = NOW;
    const message = build("Plus", (eventTime + 30 * 60_000) / 1000, eventTime);
    const readAt = eventTime + 20 * 60_000;

    const limit = parseUsageLimit(message, eventTime);

    expect(limit?.resetAt).toBe(eventTime + 30 * 60_000);
    expect(limit!.resetAt! - readAt).toBe(10 * 60_000);
  });

  it("keeps a message with no plan and no window", () => {
    const message = build(null, null, NOW);
    expect(message).toBe("You have hit your ChatGPT usage limit.");
    expect(parseUsageLimit(message, NOW)).toEqual({ plan: null, resetMinutes: null, resetAt: null });
  });

  it("keeps a plan that carries no window", () => {
    expect(parseUsageLimit(build("Business", null, NOW), NOW)).toMatchObject({ plan: "business", resetMinutes: null });
  });

  it("clamps a window that already expired", () => {
    const message = build("Plus", (NOW - 5 * 60_000) / 1000, NOW);
    expect(message).toMatch(/~0 min/);
    expect(parseUsageLimit(message, NOW)).toMatchObject({ resetMinutes: 0, resetAt: NOW });
  });

  it("finds the message inside surrounding provider text", () => {
    expect(parseUsageLimit("429: You have hit your ChatGPT usage limit (plus plan). Try again in ~3 min.", NOW))
      .toMatchObject({ resetMinutes: 3 });
  });

  it("does not claim an unrelated error is a usage limit", () => {
    expect(parseUsageLimit("429: rate_limit_exceeded", NOW)).toBeNull();
    expect(parseUsageLimit("Connection error.", NOW)).toBeNull();
    expect(isUsageLimit("Connection error.")).toBe(false);
    expect(isUsageLimit("You have hit your ChatGPT usage limit.")).toBe(true);
  });
});

describe("usageLimitAction", () => {
  it("waits out a window no longer than the configured threshold", () => {
    expect(usageLimitAction({ plan: "plus", resetMinutes: 9, resetAt: NOW }, 15)).toBe("defer");
    expect(usageLimitAction({ plan: "plus", resetMinutes: 15, resetAt: NOW }, 15)).toBe("defer");
  });

  it("fails over when the window is longer than the threshold", () => {
    expect(usageLimitAction({ plan: "plus", resetMinutes: 16, resetAt: NOW }, 15)).toBe("failover");
  });

  it("fails over rather than waiting for a window it cannot measure", () => {
    expect(usageLimitAction({ plan: null, resetMinutes: null, resetAt: null }, 15)).toBe("failover");
  });

  it("follows the configured threshold rather than a built-in one", () => {
    expect(usageLimitAction({ plan: "pro", resetMinutes: 40, resetAt: NOW }, 60)).toBe("defer");
  });
});
