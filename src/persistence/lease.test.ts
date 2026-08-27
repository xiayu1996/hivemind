import { beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { migrate } from "./migrate.js";
import { LeaseStore } from "./lease.js";

const TTL = 30_000;
let client: Client;
let clock: number;
const now = () => clock;
const store = () => new LeaseStore(client, { ttlMs: TTL, now });

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  clock = 1_000_000;
});

describe("acquisition", () => {
  it("grants a free lease", async () => {
    const lease = await store().acquire("card-1", "host-a");
    expect(lease).toMatchObject({ cardId: "card-1", holder: "host-a", fence: 1 });
  });

  it("refuses a lease held by someone else", async () => {
    await store().acquire("card-1", "host-a");
    expect(await store().acquire("card-1", "host-b")).toBeNull();
  });

  it("is idempotent for the current holder", async () => {
    const first = await store().acquire("card-1", "host-a");
    const again = await store().acquire("card-1", "host-a");
    expect(again?.holder).toBe("host-a");
    expect(again!.fence).toBeGreaterThanOrEqual(first!.fence);
  });

  it("lets another host take over once the lease expires", async () => {
    await store().acquire("card-1", "host-a");
    clock += TTL + 1;
    const taken = await store().acquire("card-1", "host-b");
    expect(taken).toMatchObject({ holder: "host-b", fence: 2 });
  });
});

describe("two hosts can never both hold one card", () => {
  it("admits exactly one winner among concurrent acquirers", async () => {
    const hosts = Array.from({ length: 12 }, (_, i) => `host-${i}`);
    const results = await Promise.all(hosts.map((h) => store().acquire("card-hot", h)));
    const winners = results.filter((r) => r !== null);

    expect(winners).toHaveLength(1);
    const held = await store().get("card-hot");
    expect(winners[0]!.holder).toBe(held!.holder);
  });

  it("keeps admitting exactly one winner across repeated expiry handovers", async () => {
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all(
        ["host-a", "host-b", "host-c"].map((h) => store().acquire("card-1", h)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      clock += TTL + 1;
    }
  });
});

describe("fencing", () => {
  it("rejects renewal from a holder whose lease was revoked", async () => {
    const lease = (await store().acquire("card-1", "host-a"))!;
    await store().revoke("card-1");
    await store().acquire("card-1", "host-b");

    // host-a is partitioned and still believes it holds the card.
    expect(await store().renew("card-1", "host-a", lease.fence)).toBeNull();
    expect((await store().get("card-1"))!.holder).toBe("host-b");
  });

  it("rejects renewal at a stale fence even for the same holder", async () => {
    const lease = (await store().acquire("card-1", "host-a"))!;
    clock += TTL + 1;
    await store().acquire("card-1", "host-a"); // fence advances
    expect(await store().renew("card-1", "host-a", lease.fence)).toBeNull();
  });

  it("rejects release from a stale holder, so it cannot free the new holder's card", async () => {
    const lease = (await store().acquire("card-1", "host-a"))!;
    clock += TTL + 1;
    await store().acquire("card-1", "host-b");

    expect(await store().release("card-1", "host-a", lease.fence)).toBe(false);
    expect((await store().get("card-1"))!.holder).toBe("host-b");
  });
});

describe("renewal", () => {
  it("pushes out the expiry for the live holder", async () => {
    const lease = (await store().acquire("card-1", "host-a"))!;
    clock += TTL / 2;
    const renewed = await store().renew("card-1", "host-a", lease.fence);
    expect(renewed!.expiresAt).toBe(clock + TTL);
  });

  it("returns null for a card with no lease", async () => {
    expect(await store().renew("ghost", "host-a", 1)).toBeNull();
  });
});

describe("release and revoke", () => {
  it("frees the card for the next acquirer", async () => {
    const lease = (await store().acquire("card-1", "host-a"))!;
    expect(await store().release("card-1", "host-a", lease.fence)).toBe(true);
    expect(await store().acquire("card-1", "host-b")).toMatchObject({ holder: "host-b" });
  });

  it("revoke removes the lease regardless of holder", async () => {
    await store().acquire("card-1", "host-a");
    expect(await store().revoke("card-1")).toBe(true);
    expect(await store().get("card-1")).toBeNull();
  });
});

describe("expiry sweep", () => {
  it("lists only leases past their expiry", async () => {
    await store().acquire("card-1", "host-a");
    clock += TTL + 1;
    await store().acquire("card-2", "host-b");

    const expired = await store().expired();
    expect(expired.map((l) => l.cardId)).toEqual(["card-1"]);
  });
});
