import { describe, expect, it, vi } from "vitest";
import {
  AllProvidersUnavailableError,
  ProviderDeferredError,
  runWithFailover,
  type FailoverDeps,
} from "./failover.js";
import { closedHealth, onProviderFailure, type BreakerPolicy, type ProviderHealth } from "./circuit-breaker.js";
import { resolveModel, staticCatalog } from "./model-resolver.js";
import { createClient } from "@libsql/client";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { assertProviderRetriesDisabled } from "./failover.js";

const NOW = 1_700_000_000_000;
const policy: BreakerPolicy = {
  failureThreshold: 1,
  transientOpenMs: 60_000,
  rateLimitOpenMs: 30_000,
  deferWithinMinutes: 15,
};

const catalog = staticCatalog([
  { provider: "openai-codex", id: "gpt-5.6-terra" },
  { provider: "zai-coding-cn", id: "glm-5" },
]);

function deps(overrides: Partial<FailoverDeps> = {}): FailoverDeps {
  const healths = new Map<string, ProviderHealth>();
  return {
    providers: async () => ["openai-codex", "zai-coding-cn"],
    modelFor: (provider) => resolveModel(catalog, provider, provider === "openai-codex" ? "gpt-5.6-terra" : "glm-5"),
    health: {
      snapshot: async () => healths,
      recordFailure: async (provider, errorMessage) => {
        const next = onProviderFailure(healths.get(provider) ?? closedHealth(provider, NOW), { at: NOW, errorMessage, policy });
        healths.set(provider, next);
        return next;
      },
      recordSuccess: async (provider) => {
        const next = closedHealth(provider, NOW);
        healths.set(provider, next);
        return next;
      },
    },
    policy,
    now: () => NOW,
    ...overrides,
  };
}

describe("runWithFailover", () => {
  it("runs the first usable provider and records its success", async () => {
    const context = deps();
    const attempt = vi.fn(async () => "done");

    await expect(runWithFailover("code", attempt, context)).resolves.toBe("done");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt.mock.calls[0]).toMatchObject([{ provider: "openai-codex", id: "gpt-5.6-terra" }]);
    await expect(context.health.snapshot()).resolves.toMatchObject(new Map([["openai-codex", { state: "closed" }]]));
  });

  it("moves the whole phase to the next provider rather than swapping models inside it", async () => {
    const context = deps();
    const seen: string[] = [];
    const attempt = vi.fn(async (model: { provider: string }) => {
      seen.push(model.provider);
      if (model.provider === "openai-codex") throw new Error("500: server_error");
      return "done";
    });

    await expect(runWithFailover("code", attempt, context)).resolves.toBe("done");
    expect(seen).toEqual(["openai-codex", "zai-coding-cn"]);
    const healths = await context.health.snapshot();
    expect(healths.get("openai-codex")).toMatchObject({ state: "open", lastErrorClass: "SERVER" });
    expect(healths.get("zai-coding-cn")).toMatchObject({ state: "closed" });
  });

  it("skips a provider whose breaker is already open without spending an attempt", async () => {
    const context = deps();
    await context.health.recordFailure("openai-codex", "401: unauthorized", policy);
    const attempt = vi.fn(async () => "done");

    await expect(runWithFailover("code", attempt, context)).resolves.toBe("done");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt.mock.calls[0]).toMatchObject([{ provider: "zai-coding-cn" }]);
  });

  it("defers instead of switching when the window is short enough to wait out", async () => {
    const context = deps();
    const attempt = vi.fn(async () => {
      throw new Error("You have hit your ChatGPT usage limit (plus plan). Try again in ~9 min.");
    });

    await expect(runWithFailover("code", attempt, context)).rejects.toBeInstanceOf(ProviderDeferredError);
    // The second provider is deliberately not tried: waiting out nine minutes is
    // cheaper than re-running the whole phase somewhere else.
    expect(attempt).toHaveBeenCalledTimes(1);
    await expect(runWithFailover("code", attempt, context).catch((cause: ProviderDeferredError) => cause.resumeAt))
      .resolves.toBe(NOW + 9 * 60_000);
  });

  it("fails over when the window is too long to wait out", async () => {
    const context = deps();
    const attempt = vi.fn(async (model: { provider: string }) => {
      if (model.provider === "openai-codex") throw new Error("You have hit your ChatGPT usage limit. Try again in ~47 min.");
      return "done";
    });

    await expect(runWithFailover("code", attempt, context)).resolves.toBe("done");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("reports the whole chain as unavailable rather than retrying silently", async () => {
    const context = deps();
    const attempt = vi.fn(async () => {
      throw new Error("401: invalid_api_key");
    });

    await expect(runWithFailover("code", attempt, context)).rejects.toBeInstanceOf(AllProvidersUnavailableError);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("refuses to start when no provider serves the purpose at all", async () => {
    const context = deps({ providers: async () => [] });
    await expect(runWithFailover("code", vi.fn(), context)).rejects.toBeInstanceOf(AllProvidersUnavailableError);
  });
});

describe("assertProviderRetriesDisabled", () => {
  it("accepts the default and refuses a provider-side retry the orchestrator cannot see", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const config = await ConfigStore.load(client);

    await expect(assertProviderRetriesDisabled(config)).resolves.toBeUndefined();

    await config.set("retry.providerAutoRetries", 2, "test");
    await expect(assertProviderRetriesDisabled(config)).rejects.toThrow(/must be 0/);
    client.close();
  });
});
