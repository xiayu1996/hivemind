import { beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { ProviderSlotStore } from "../queue/provider-slots.js";
import { resolveModel } from "./model-resolver.js";
import { NoProviderAvailableError, SpawnBroker, type SpawnBrokerOptions } from "./spawn-broker.js";
import type { AgentModelPolicy } from "./agent-spec.js";

const LEASE_MS = 60_000;
let client: Client;
let clock: number;
const now = () => clock;

async function policy(chain: readonly string[], failing: ReadonlySet<string> = new Set()): Promise<AgentModelPolicy> {
  const models = new Map(await Promise.all(chain.map(async (provider) =>
    [provider, await resolveModel({ list: async () => [{ provider, id: `${provider}-1` }] }, provider, `${provider}-1`)] as const)));
  return {
    resolve: async (_purpose, provider) => {
      if (failing.has(provider)) throw new Error(`${provider} has no model for this tier`);
      return models.get(provider)!;
    },
    providersFor: async () => [...chain],
    tierOf: async () => "standard",
    isMetered: async () => false,
  };
}

/** A store that caps one provider at a single concurrent spawn. */
async function cappedConfig(provider: string): Promise<ConfigStore> {
  const config = await ConfigStore.load(client);
  await config.set("schedule.maxConcurrentPerProvider", { [provider]: 1 }, "spawn-broker test");
  return config;
}

function broker(over: Partial<SpawnBrokerOptions> & { policy: AgentModelPolicy }): SpawnBroker {
  return new SpawnBroker({
    config: ConfigStore.defaults(),
    slots: new ProviderSlotStore(client, { leaseMs: LEASE_MS, now }),
    cardId: "S-EPIC1-01",
    holder: "host-a:1",
    waitMs: 1,
    sleep: async () => { clock += 1; },
    now,
    ...over,
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  clock = 1_000_000;
});

describe("granting a spawn", () => {
  it("resolves the spec and holds the provider's capacity until it is released", async () => {
    const slots = new ProviderSlotStore(client, { leaseMs: LEASE_MS, now });
    const grant = await broker({ policy: await policy(["mock"]), slots }).grant("code");

    expect(grant.spec.model.provider).toBe("mock");
    expect(await slots.inFlight()).toEqual(new Map([["mock", 1]]));

    await grant.release();
    expect(await slots.inFlight()).toEqual(new Map());
  });

  it("walks past a circuit-broken provider to the next one on the chain", async () => {
    const grant = await broker({
      policy: await policy(["codex", "deepseek"]),
      unhealthy: async () => new Set(["codex"]),
    }).grant("code");

    expect(grant.spec.model.provider).toBe("deepseek");
  });

  it("walks past a provider this host has no working credentials for, and names it if none is left", async () => {
    const options = {
      policy: await policy(["codex", "deepseek"]),
      ready: async (provider: string) => provider === "deepseek"
        ? { ready: true }
        : { ready: false, reason: "the stored token no longer refreshes" },
    };
    expect((await broker(options).grant("code")).spec.model.provider).toBe("deepseek");

    const none = broker({
      policy: await policy(["codex"]),
      ready: async () => ({ ready: false, reason: "the stored token no longer refreshes" }),
    });
    await expect(none.grant("code")).rejects.toThrow(/no longer refreshes/);
  });

  it("refuses a purpose no provider serves rather than spawning on a guess", async () => {
    await expect(broker({ policy: await policy([]) }).grant("code"))
      .rejects.toThrow(NoProviderAvailableError);
  });

  it("waits for a full bucket instead of failing, and takes the slot once one is freed", async () => {
    const slots = new ProviderSlotStore(client, { leaseMs: LEASE_MS, now });
    const config = await cappedConfig("mock");
    const taken = await slots.acquire({
      provider: "mock", cardId: "S-EPIC1-02", holder: "host-a:2", purpose: "code", capacity: 1,
    });
    let waits = 0;

    const pending = broker({
      config,
      policy: await policy(["mock"]),
      slots,
      sleep: async () => {
        waits += 1;
        clock += 1;
        // The other card's phase ends while this one is waiting.
        if (waits === 2) await slots.release(taken!.slotId);
      },
    }).grant("code");

    await expect(pending).resolves.toMatchObject({ spec: { model: { provider: "mock" } } });
    expect(waits).toBe(2);
  });

  it("gives up once the wait is longer than a card should ever spend waiting", async () => {
    const slots = new ProviderSlotStore(client, { leaseMs: LEASE_MS, now });
    await slots.acquire({
      provider: "mock", cardId: "S-EPIC1-02", holder: "host-a:2", purpose: "code", capacity: 1,
    });

    await expect(broker({
      config: await cappedConfig("mock"),
      policy: await policy(["mock"]),
      slots,
      maxWaitMs: 3,
      sleep: async () => { clock += 2; },
    }).grant("code")).rejects.toThrow(/every bucket stayed full/);
  });

  it("does not keep the slot of a provider whose spec would not resolve", async () => {
    const slots = new ProviderSlotStore(client, { leaseMs: LEASE_MS, now });
    const grant = await broker({
      policy: await policy(["codex", "deepseek"], new Set(["codex"])),
      slots,
    }).grant("code");

    expect(grant.spec.model.provider).toBe("deepseek");
    expect(await slots.inFlight()).toEqual(new Map([["deepseek", 1]]));
  });
});
