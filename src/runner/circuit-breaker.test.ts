import { describe, expect, it } from "vitest";
import {
  closedHealth,
  intakeHalted,
  onProviderFailure,
  onProviderSuccess,
  probeDue,
  usableProviders,
  type BreakerPolicy,
  type ProviderHealth,
} from "./circuit-breaker.js";

const NOW = 1_700_000_000_000;
const policy: BreakerPolicy = {
  failureThreshold: 3,
  transientOpenMs: 60_000,
  rateLimitOpenMs: 30_000,
  deferWithinMinutes: 15,
};

function fail(health: ProviderHealth, errorMessage: string, at = NOW): ProviderHealth {
  return onProviderFailure(health, { at, errorMessage, policy });
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

  it("opens immediately on an authentication failure, which no amount of waiting fixes", () => {
    const health = fail(closedHealth("openai-codex", NOW), "401: invalid_api_key");
    expect(health).toMatchObject({ state: "open", lastErrorClass: "AUTH", needsHuman: true });
  });

  it("opens a usage limit until the window its own message reports", () => {
    const health = fail(closedHealth("openai-codex", NOW), "You have hit your ChatGPT usage limit (plus plan). Try again in ~47 min.");
    expect(health).toMatchObject({
      state: "open",
      lastErrorClass: "QUOTA",
      retryAt: NOW + 47 * 60_000,
      needsHuman: false,
    });
  });

  it("treats a spent balance with no window as needing a human", () => {
    const health = fail(closedHealth("zai-coding-cn", NOW), "429: insufficient_quota");
    expect(health).toMatchObject({ state: "open", lastErrorClass: "QUOTA", needsHuman: true, retryAt: null });
  });

  it("holds a rate limit open only for its own short window", () => {
    const health = fail(closedHealth("openai-codex", NOW), "429: rate_limit_exceeded");
    expect(health).toMatchObject({ state: "open", lastErrorClass: "RATE_LIMIT", retryAt: NOW + 30_000 });
  });

  it("admits a probe only once the window has passed, and never for a human-owned failure", () => {
    const transient = fail(fail(fail(closedHealth("openai-codex", NOW), "timeout"), "timeout"), "timeout");
    expect(probeDue(transient, NOW + 59_000)).toBe(false);
    expect(probeDue(transient, NOW + 60_000)).toBe(true);

    const auth = fail(closedHealth("openai-codex", NOW), "401: unauthorized");
    expect(probeDue(auth, NOW + 86_400_000)).toBe(true);
  });

  it("drops only the broken provider from the chain and keeps the order", () => {
    const chain = ["openai-codex", "zai-coding-cn", "xai"];
    const healths = new Map([
      ["openai-codex", fail(closedHealth("openai-codex", NOW), "429: insufficient_quota")],
      ["zai-coding-cn", closedHealth("zai-coding-cn", NOW)],
      ["xai", closedHealth("xai", NOW)],
    ]);
    expect(usableProviders(chain, healths, NOW)).toEqual(["zai-coding-cn", "xai"]);
    expect(intakeHalted(chain, healths, NOW)).toBe(false);
  });

  it("halts intake only when the whole chain is open", () => {
    const chain = ["openai-codex", "zai-coding-cn"];
    const healths = new Map(chain.map((provider) => [
      provider,
      fail(closedHealth(provider, NOW), "429: insufficient_quota"),
    ]));
    expect(usableProviders(chain, healths, NOW)).toEqual([]);
    expect(intakeHalted(chain, healths, NOW)).toBe(true);
  });

  it("counts a provider with no health record yet as usable", () => {
    expect(usableProviders(["openai-codex"], new Map(), NOW)).toEqual(["openai-codex"]);
  });

  it("lets a provider back into the chain once its window has passed", () => {
    const healths = new Map([
      ["openai-codex", fail(closedHealth("openai-codex", NOW), "429: rate_limit_exceeded")],
    ]);
    expect(usableProviders(["openai-codex"], healths, NOW + 29_000)).toEqual([]);
    expect(usableProviders(["openai-codex"], healths, NOW + 30_000)).toEqual(["openai-codex"]);
  });
});
