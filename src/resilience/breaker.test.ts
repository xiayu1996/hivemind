import { describe, expect, it } from "vitest";
import {
  closedHealth,
  DEFAULT_BREAKER_POLICY,
  earliestRetryAt,
  onProviderFailure,
  onProviderSuccess,
  probeDue,
  shouldWaitFor,
  usableProviders,
  type BreakerPolicy,
  type ProviderHealth,
} from "./breaker.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const policy = DEFAULT_BREAKER_POLICY;

function fail(health: ProviderHealth, errorMessage: string, at = NOW, activePolicy: BreakerPolicy = policy): ProviderHealth {
  return onProviderFailure(health, { at, errorMessage, policy: activePolicy });
}

function failedOnce(provider: string, errorMessage: string, at = NOW): ProviderHealth {
  return fail(closedHealth(provider, at), errorMessage, at);
}

describe("provider circuit breaker", () => {
  it("keeps a provider closed while transient failures stay under the threshold", () => {
    let health = closedHealth("openai-codex", NOW);
    health = fail(health, "socket hang up");
    health = fail(health, "socket hang up");
    expect(health).toMatchObject({ state: "closed", consecutiveFailures: 2, lastErrorClass: "TRANSPORT" });
  });

  it("opens on the third consecutive transient failure and closes again on success", () => {
    let health = closedHealth("openai-codex", NOW);
    for (let attempt = 0; attempt < 3; attempt++) health = fail(health, "fetch failed");
    expect(health).toMatchObject({ state: "open", consecutiveFailures: 3, retryAt: NOW + 60_000 });

    health = onProviderSuccess(health, NOW + 61_000);
    expect(health).toMatchObject({ state: "closed", consecutiveFailures: 0, retryAt: null, lastErrorClass: null });
  });

  it("tolerates one wording nothing recognises rather than parking on a single oddity", () => {
    expect(failedOnce("deepseek", "the flux capacitor disagreed")).toMatchObject({ state: "closed", lastErrorClass: "UNKNOWN" });
  });

  it("parks a provider that keeps saying something nothing recognises, and tells a person", () => {
    // No self-healing window: nothing knows what would have to change for the
    // next attempt to differ, so reopening on a timer repeats the failure while
    // telling nobody. This is how a spent DeepSeek balance used to behave.
    let health = closedHealth("deepseek", NOW);
    for (let attempt = 0; attempt < 3; attempt++) health = fail(health, "the flux capacitor disagreed");
    expect(health).toMatchObject({ state: "open", lastErrorClass: "UNKNOWN", retryAt: null, needsHuman: true });
  });

  it("opens immediately on an authentication failure, which no amount of waiting fixes", () => {
    expect(failedOnce("openai-codex", "401: invalid_api_key")).toMatchObject({ state: "open", lastErrorClass: "AUTH", needsHuman: true });
  });

  it("opens a usage limit until the window its own message reports", () => {
    const health = failedOnce("openai-codex", "You have hit your ChatGPT usage limit (plus plan). Try again in ~47 min.");
    expect(health).toMatchObject({ state: "open", lastErrorClass: "QUOTA", retryAt: NOW + 47 * MINUTE, needsHuman: false });
  });

  it("holds a usage limit that names no window for the configured period instead of asking a person", () => {
    const health = failedOnce("openai-codex", "Codex error: The usage limit has been reached");
    expect(health).toMatchObject({ state: "open", lastErrorClass: "QUOTA", retryAt: NOW + 30 * MINUTE, needsHuman: false });
    expect(probeDue(health, NOW + 29 * MINUTE)).toBe(false);
    expect(probeDue(health, NOW + 30 * MINUTE)).toBe(true);
  });

  it("doubles the windowless usage-limit hold up to the ceiling", () => {
    // The hold is a guess, and the only way to test it is to spend a dispatch:
    // repeating the same guess every 30 minutes burns quota on probing alone.
    const capped: BreakerPolicy = { ...policy, quotaHoldMs: 30 * MINUTE, quotaHoldMaxMs: 2 * HOUR };
    const message = "Codex error: The usage limit has been reached";
    let health = fail(closedHealth("openai-codex", NOW), message, NOW, capped);
    expect(health.retryAt).toBe(NOW + 30 * MINUTE);
    health = fail(health, message, NOW, capped);
    expect(health.retryAt).toBe(NOW + 60 * MINUTE);
    health = fail(health, message, NOW, capped);
    expect(health.retryAt).toBe(NOW + 120 * MINUTE);
    health = fail(health, message, NOW, capped);
    expect(health.retryAt).toBe(NOW + 120 * MINUTE);
    expect(onProviderSuccess(health, NOW).consecutiveFailures).toBe(0);
  });

  it("treats a spent balance with no window as needing a human", () => {
    expect(failedOnce("zai-coding-cn", "429: insufficient_quota"))
      .toMatchObject({ state: "open", lastErrorClass: "QUOTA", needsHuman: true, retryAt: null });
  });

  it("holds a rate limit open only for its own short window", () => {
    expect(failedOnce("openai-codex", "429: rate_limit_exceeded"))
      .toMatchObject({ state: "open", lastErrorClass: "RATE_LIMIT", retryAt: NOW + 30_000 });
  });

  it("holds a rate limit for exactly the delay the provider asked for", () => {
    // Our 30-second default would re-probe a provider that asked for an hour
    // a hundred and twenty times before it was ready.
    expect(failedOnce("openai-codex", "Server requested 3600s retry delay (max: 60s)"))
      .toMatchObject({ state: "open", lastErrorClass: "RATE_LIMIT", retryAt: NOW + HOUR, needsHuman: false });
  });

  it("admits a probe only once the window has passed, and at any time for a human-owned failure", () => {
    const transient = fail(fail(failedOnce("openai-codex", "timeout"), "timeout"), "timeout");
    expect(probeDue(transient, NOW + 59_000)).toBe(false);
    expect(probeDue(transient, NOW + 60_000)).toBe(true);

    expect(probeDue(failedOnce("openai-codex", "401: unauthorized"), NOW + 86_400_000)).toBe(true);
  });

  it("drops only the broken provider from the chain and keeps the order", () => {
    const chain = ["openai-codex", "zai-coding-cn", "xai"];
    const healths = new Map([
      ["openai-codex", failedOnce("openai-codex", "429: insufficient_quota")],
      ["zai-coding-cn", closedHealth("zai-coding-cn", NOW)],
      ["xai", closedHealth("xai", NOW)],
    ]);
    expect(usableProviders(chain, healths, NOW)).toEqual(["zai-coding-cn", "xai"]);
  });

  it("leaves nothing usable only when the whole chain is open", () => {
    const chain = ["openai-codex", "zai-coding-cn"];
    const healths = new Map(chain.map((provider) => [provider, failedOnce(provider, "429: insufficient_quota")]));
    expect(usableProviders(chain, healths, NOW)).toEqual([]);
  });

  it("counts a provider with no health record yet as usable", () => {
    expect(usableProviders(["openai-codex"], new Map(), NOW)).toEqual(["openai-codex"]);
  });

  it("lets a provider back into the chain once its window has passed", () => {
    const healths = new Map([["openai-codex", failedOnce("openai-codex", "429: rate_limit_exceeded")]]);
    expect(usableProviders(["openai-codex"], healths, NOW + 29_000)).toEqual([]);
    expect(usableProviders(["openai-codex"], healths, NOW + 30_000)).toEqual(["openai-codex"]);
  });
});

describe("a window the provider named", () => {
  const at = Date.parse("2026-09-22T05:00:00.000Z");

  it("holds until the exact reset a weekly limit reported", () => {
    // The live failure: without this the breaker used its own backoff and
    // probed the same wall every twenty minutes for three days.
    const message = `429: {"message":"You've reached your weekly usage limit for your plan. `
      + `Your limit resets at 2026-09-25T09:16:02.084Z.","type":"rate_limit_error","code":"RATE_LIMITED"}`;

    const health = failedOnce("command-code", message, at);
    expect(health).toMatchObject({ state: "open", needsHuman: false });
    expect(health.retryAt).toBe(Date.parse("2026-09-25T09:16:02.084Z"));
    expect(probeDue(health, at + HOUR)).toBe(false);
  });

  it("stretches the blind hold to fit a window it can only name", () => {
    let health = closedHealth("command-code", at);
    for (let failure = 0; failure < 8; failure += 1) health = fail(health, "You have reached your weekly usage limit.", at);
    // The policy ceiling alone would be four hours; a week-long window earns a day.
    expect(health.retryAt).toBe(at + 24 * HOUR);
  });
});

describe("when the chain next has a provider back", () => {
  it("is the soonest reopening among providers that heal on their own", () => {
    const chain = ["openai-codex", "command-code", "deepseek"];
    const healths = new Map([
      ["openai-codex", failedOnce("openai-codex", "You have hit your ChatGPT usage limit (plus plan). Try again in ~47 min.")],
      ["command-code", failedOnce("command-code", "429: rate_limit_exceeded")],
      ["deepseek", failedOnce("deepseek", "401: invalid_api_key")],
    ]);
    expect(earliestRetryAt(chain, healths)).toBe(NOW + 30_000);
  });

  it("is nothing when every open provider needs a person", () => {
    const chain = ["openai-codex", "deepseek"];
    const healths = new Map([
      ["openai-codex", failedOnce("openai-codex", "401: invalid_api_key")],
      ["deepseek", failedOnce("deepseek", '402: {"message":"Insufficient Balance"}')],
    ]);
    expect(earliestRetryAt(chain, healths)).toBeNull();
  });

  it("looks only at open providers in the chain", () => {
    const healths = new Map([
      ["openai-codex", closedHealth("openai-codex", NOW)],
      ["xai", failedOnce("xai", "429: rate_limit_exceeded")],
    ]);
    expect(earliestRetryAt(["openai-codex", "deepseek"], healths)).toBeNull();
  });
});

describe("waiting for a provider instead of failing over", () => {
  it("waits out a window the provider says reopens soon, and resumes when the breaker does", () => {
    // Waiting nine minutes is cheaper than re-running the whole unit elsewhere.
    const health = failedOnce("openai-codex", "You have hit your ChatGPT usage limit (plus plan). Try again in ~9 min.");
    expect(shouldWaitFor(health, NOW, policy)).toBe(true);
    expect(health.retryAt).toBe(NOW + 9 * MINUTE);
  });

  it("fails over past a window too long to wait out", () => {
    const health = failedOnce("openai-codex", "You have hit your ChatGPT usage limit (plus plan). Try again in ~47 min.");
    expect(shouldWaitFor(health, NOW, policy)).toBe(false);
  });

  it("counts the window from the failure and the wait from the decision", () => {
    const health = failedOnce("openai-codex", "You have hit your ChatGPT usage limit (plus plan). Try again in ~20 min.");
    expect(health.retryAt).toBe(NOW + 20 * MINUTE);
    expect(shouldWaitFor(health, NOW, policy)).toBe(false);
    expect(shouldWaitFor(health, NOW + 10 * MINUTE, policy)).toBe(true);
  });

  it("waits out a rate limit whose provider asked for a short delay", () => {
    const health = failedOnce("openai-codex", "Server requested 120s retry delay (max: 60s)");
    expect(shouldWaitFor(health, NOW, policy)).toBe(true);
    expect(health.retryAt).toBe(NOW + 120_000);
  });

  it("never waits on a hold the breaker guessed", () => {
    // The wait would be a guess, and failing over costs a cheaper model rather
    // than idle work.
    expect(shouldWaitFor(failedOnce("openai-codex", "429: rate_limit_exceeded"), NOW, policy)).toBe(false);
    expect(shouldWaitFor(failedOnce("openai-codex", "Codex error: The usage limit has been reached"), NOW, policy)).toBe(false);
    expect(shouldWaitFor(failedOnce("command-code", "You have reached your weekly usage limit."), NOW, policy)).toBe(false);
    let transient = closedHealth("openai-codex", NOW);
    for (let attempt = 0; attempt < 3; attempt++) transient = fail(transient, "fetch failed");
    expect(shouldWaitFor(transient, NOW, policy)).toBe(false);
    expect(shouldWaitFor(closedHealth("openai-codex", NOW), NOW, policy)).toBe(false);
  });

  it("never waits on what needs a person", () => {
    expect(shouldWaitFor(failedOnce("openai-codex", "401: invalid_api_key"), NOW, policy)).toBe(false);
    expect(shouldWaitFor(failedOnce("deepseek", '402: {"message":"Insufficient Balance"}'), NOW, policy)).toBe(false);
  });
});
