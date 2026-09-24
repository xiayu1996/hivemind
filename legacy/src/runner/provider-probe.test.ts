import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { closedHealth, onProviderFailure, type BreakerPolicy } from "./circuit-breaker.js";
import { LibsqlProviderHealthStore } from "./provider-health-store.js";
import { probeOpenProviders } from "./provider-probe.js";

const policy: BreakerPolicy = {
  failureThreshold: 1,
  transientOpenMs: 60_000,
  rateLimitOpenMs: 30_000,
  deferWithinMinutes: 15,
};

describe("probeOpenProviders", () => {
  let client: ReturnType<typeof createClient>;
  let store: LibsqlProviderHealthStore;
  let time: number;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    time = 1_700_000_000_000;
    store = new LibsqlProviderHealthStore(client, () => time);
  });

  afterEach(() => client.close());

  it("closes a breaker whose credentials a human has since repaired", async () => {
    await store.recordFailure("openai-codex", "401: unauthorized", policy);
    time += 3_600_000;
    const probe = vi.fn(async () => ({ ready: true, provider: "openai-codex", reason: null }));

    await probeOpenProviders(["openai-codex"], store, probe, policy, () => time);

    expect(probe).toHaveBeenCalledWith("openai-codex");
    expect((await store.snapshot()).get("openai-codex")).toMatchObject({ state: "closed", lastProbeAt: time });
  });

  it("leaves the breaker open when the credentials are still not ready", async () => {
    await store.recordFailure("openai-codex", "401: unauthorized", policy);
    time += 3_600_000;

    await probeOpenProviders(
      ["openai-codex"],
      store,
      async () => ({ ready: false, provider: "openai-codex", reason: "not_ready" }),
      policy,
      () => time,
    );

    expect((await store.snapshot()).get("openai-codex")).toMatchObject({ state: "open", lastProbeAt: time });
  });

  it("does not spend a probe on a closed provider or before the window passes", async () => {
    await store.recordSuccess("openai-codex");
    const rateLimited = onProviderFailure(closedHealth("zai-coding-cn", time), {
      at: time,
      errorMessage: "429: rate_limit_exceeded",
      policy,
    });
    await store.recordFailure("zai-coding-cn", "429: rate_limit_exceeded", policy);
    expect(rateLimited.retryAt).toBe(time + 30_000);
    const probe = vi.fn(async () => ({ ready: true, provider: "x", reason: null }));

    await probeOpenProviders(["openai-codex", "zai-coding-cn"], store, probe, policy, () => time + 10_000);

    expect(probe).not.toHaveBeenCalled();
  });

  it("treats an unreachable probe as a failed one rather than crashing the cycle", async () => {
    await store.recordFailure("openai-codex", "401: unauthorized", policy);
    time += 3_600_000;

    await expect(probeOpenProviders(
      ["openai-codex"],
      store,
      async () => { throw new Error("pi binary is missing"); },
      policy,
      () => time,
    )).resolves.toBeUndefined();

    expect((await store.snapshot()).get("openai-codex")).toMatchObject({ state: "open", lastProbeAt: time });
  });
});
