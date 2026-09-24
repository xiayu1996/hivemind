import { beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { migrate } from "../persistence/migrate.js";
import { ProviderSlotStore, defaultCapacity } from "./provider-slots.js";

const LEASE_MS = 60_000;
let client: Client;
let clock: number;
const now = () => clock;
const store = () => new ProviderSlotStore(client, { leaseMs: LEASE_MS, now });
const take = (provider: string, cardId: string, holder: string, capacity: number) =>
  store().acquire({ provider, cardId, holder, purpose: "code", capacity });

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  clock = 1_000_000;
});

describe("per-provider capacity", () => {
  it("lets a second card in only when the provider has room for it", async () => {
    expect(await take("codex", "card-1", "host-a:1", 1)).not.toBeNull();
    expect(await take("codex", "card-2", "host-a:2", 1)).toBeNull();
  });

  it("runs cards on different providers side by side", async () => {
    expect(await take("codex", "card-1", "host-a:1", 1)).not.toBeNull();
    expect(await take("deepseek", "card-2", "host-a:2", 1)).not.toBeNull();
  });

  it("frees the capacity a failover left behind, so the next phase can take another provider's slot", async () => {
    const first = await take("codex", "card-1", "host-a:1", 1);
    await store().release(first!.slotId);

    expect(await take("codex", "card-2", "host-a:2", 1)).not.toBeNull();
  });

  it("gives a killed holder's capacity back when its lease runs out, with nobody sweeping", async () => {
    expect(await take("codex", "card-1", "host-a:1", 1)).not.toBeNull();
    expect(await take("codex", "card-2", "host-a:2", 1)).toBeNull();

    clock += LEASE_MS + 1;

    expect(await take("codex", "card-2", "host-a:2", 1)).not.toBeNull();
  });

  it("keeps a long phase's slot while it heartbeats", async () => {
    const slot = await take("codex", "card-1", "host-a:1", 1);
    clock += LEASE_MS - 1;
    expect(await store().heartbeat(slot!.slotId)).toBe(true);
    clock += LEASE_MS - 1;

    expect(await take("codex", "card-2", "host-a:2", 1)).toBeNull();
  });

  it("reports nothing to heartbeat once the slot is gone", async () => {
    const slot = await take("codex", "card-1", "host-a:1", 1);
    await store().release(slot!.slotId);
    expect(await store().heartbeat(slot!.slotId)).toBe(false);
  });

  it("drops everything one execution holds, for a crash-safe exit", async () => {
    await take("codex", "card-1", "host-a:1", 2);
    await take("codex", "card-2", "host-a:1", 2);
    await store().releaseHolder("host-a:1");

    expect(await store().inFlight()).toEqual(new Map());
  });

  it("counts only live slots, which is why an expired one needs no recovery", async () => {
    await take("codex", "card-1", "host-a:1", 2);
    await take("deepseek", "card-2", "host-a:2", 2);
    expect(await store().inFlight()).toEqual(new Map([["codex", 1], ["deepseek", 1]]));

    clock += LEASE_MS + 1;
    expect(await store().inFlight()).toEqual(new Map());
    expect(await store().reapExpired()).toBe(2);
  });

  it("is tighter on a subscription than on a metered key, because that limit is undocumented", () => {
    expect(defaultCapacity("oauth")).toBe(2);
    expect(defaultCapacity("api_key")).toBe(4);
  });
});
