import { describe, expect, it } from "vitest";
import { backoffCeilingMs, readResetWindow } from "./reset-window.ts";

/** 2026-09-22T05:00:00Z, the instant the provider produced the message. */
const EVENT = Date.parse("2026-09-22T05:00:00.000Z");
const HOUR = 3_600_000;

describe("what a provider says about its window", () => {
  it("takes an absolute reset days out, which is what command-code reports", () => {
    // Verbatim from provider_health on 2026-09-22.
    const message = `429: {"message":"You've reached your weekly usage limit for your plan. `
      + `Your limit resets at 2026-09-25T09:16:02.084Z. Please wait for the window to reset or `
      + `upgrade your plan to continue.","type":"rate_limit_error","code":"RATE_LIMITED"}`;

    expect(readResetWindow(message, EVENT)).toMatchObject({
      source: "absolute",
      resetAt: Date.parse("2026-09-25T09:16:02.084Z"),
    });
  });

  it("anchors a relative window to the event rather than to when it is read", () => {
    // pi flattens the ChatGPT usage limit to minutes counted when it built the
    // string, so reading them against a later clock computes a stale window.
    const message = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";

    expect(readResetWindow(message, EVENT)?.resetAt).toBe(EVENT + 42 * 60_000);
    expect(readResetWindow(message, EVENT + HOUR)?.resetAt).toBe(EVENT + HOUR + 42 * 60_000);
  });

  it("adds up a window written in more than one unit", () => {
    expect(readResetWindow("Rate limited. Try again in 2h 15m.", EVENT)?.resetAt)
      .toBe(EVENT + 2 * HOUR + 15 * 60_000);
  });

  it("reads the seconds of a retry-after, which carries no units at all", () => {
    expect(readResetWindow("429 Too Many Requests (retry-after: 3600)", EVENT)?.resetAt)
      .toBe(EVENT + HOUR);
  });

  it("reads the delay pi reports when a provider asks for a longer wait than pi sleeps for", () => {
    // openai-codex-responses words it without the provider's text; the shared
    // provider retry appends it, and the header's figure beats the prose.
    expect(readResetWindow("Server requested 3600s retry delay (max: 60s)", EVENT))
      .toMatchObject({ source: "relative", resetAt: EVENT + HOUR });
    const appended = "Server requested 120s retry delay (max: 60s). 429 Rate limit reached for gpt-5 "
      + "in organization org-mock on tokens per min (TPM). Please try again in 20s.";
    expect(readResetWindow(appended, EVENT)?.resetAt).toBe(EVENT + 120_000);
  });

  it("reads an epoch reset, in seconds or milliseconds", () => {
    const at = Date.parse("2026-09-22T08:00:00.000Z");
    expect(readResetWindow(`{"resets_at":${at / 1000}}`, EVENT)?.resetAt).toBe(at);
    expect(readResetWindow(`{"reset_at":${at}}`, EVENT)?.resetAt).toBe(at);
  });

  it("keeps the length of a window it cannot place, and no instant", () => {
    // "weekly" says how long these windows are, not when this one ends: it may
    // have a minute left. Turning the length into a wait would idle the chain
    // for a week over a window that had already reopened.
    expect(readResetWindow("You have reached your weekly limit.", EVENT))
      .toMatchObject({ source: "named", resetAt: null, windowMs: 7 * 24 * HOUR });
    expect(readResetWindow("Your 5-hour limit has been reached.", EVENT))
      .toMatchObject({ source: "named", resetAt: null, windowMs: 5 * HOUR });
  });

  it("ignores a reset already in the past, which would loop rather than wait", () => {
    expect(readResetWindow("Your limit resets at 2026-09-21T09:00:00.000Z.", EVENT)).toBeNull();
  });

  it("ignores a date too far out to be a window", () => {
    expect(readResetWindow("Your limit resets at 2027-09-25T09:16:02.084Z.", EVENT)).toBeNull();
  });

  it("says nothing about a message with no window in it", () => {
    expect(readResetWindow("402 Insufficient Balance", EVENT)).toBeNull();
    expect(readResetWindow("model gpt-5.6-terra returned 500 after 3 attempts", EVENT)).toBeNull();
    expect(readResetWindow(undefined, EVENT)).toBeNull();
  });
});

describe("how far a blind backoff may grow", () => {
  it("stretches it to fit a long named window, never shrinking it", () => {
    const policyCeiling = 4 * HOUR;
    expect(backoffCeilingMs(readResetWindow("weekly limit reached", EVENT), policyCeiling))
      .toBe(24 * HOUR);
    // An hourly window is shorter than the policy ceiling; the ceiling stands,
    // because a shorter one only means more probes against the same wall.
    expect(backoffCeilingMs(readResetWindow("hourly limit reached", EVENT), policyCeiling))
      .toBe(policyCeiling);
    expect(backoffCeilingMs(null, policyCeiling)).toBe(policyCeiling);
  });
});
