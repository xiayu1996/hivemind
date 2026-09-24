import { beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { migrate } from "../persistence/migrate.js";
import { LeaseStore, type LeaseHolder } from "../persistence/lease.js";
import { DispatchQueue, dispatchableFrom } from "./dispatch.js";

const TTL = 30_000;
let client: Client;
let clock: number;
const now = () => clock;
const holder = (instanceId: string): LeaseHolder => ({ hostId: "host-a", instanceId });
const leases = () => new LeaseStore(client, { ttlMs: TTL, now });
const queue = () => new DispatchQueue(client, { now });

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  clock = 1_000_000;
});

describe("dispatchable set", () => {
  it("offers every planned card when nothing is running", async () => {
    expect(await queue().dispatchable(["card-1", "card-2"])).toEqual(["card-1", "card-2"]);
  });

  it("keeps the plan's order", async () => {
    expect(await queue().dispatchable(["card-2", "card-1"])).toEqual(["card-2", "card-1"]);
  });

  it("withholds a card a worker already holds", async () => {
    await leases().acquire("card-1", holder("i1"));
    expect(await queue().dispatchable(["card-1", "card-2"])).toEqual(["card-2"]);
  });

  it("does not offer a held card again after the coordinator restarts", async () => {
    await leases().acquire("card-1", holder("i1"));
    // A fresh coordinator has no memory of what it dispatched; the lease is
    // what keeps the card from being handed to a second subprocess.
    expect(await new DispatchQueue(client, { now }).dispatchable(["card-1"])).toEqual([]);
  });

  it("offers a card whose holder died and let the lease expire", async () => {
    await leases().acquire("card-1", holder("i1"));
    clock += TTL + 1;
    expect(await queue().dispatchable(["card-1"])).toEqual(["card-1"]);
  });

  it("offers a card again once its worker released it", async () => {
    const lease = await leases().acquire("card-1", holder("i1"));
    await leases().release("card-1", holder("i1"), lease!.fence);
    expect(await queue().dispatchable(["card-1"])).toEqual(["card-1"]);
  });
});

describe("dispatchableFrom", () => {
  it("reads a released lease's zero expiry as free", () => {
    expect(dispatchableFrom(["card-1"], [{ cardId: "card-1", holder: "h", expiresAt: 0 }], 10)).toEqual(["card-1"]);
  });
});
