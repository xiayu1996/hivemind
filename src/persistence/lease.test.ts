import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { migrate } from "./migrate.js";
import { LeaseFenceError, LeaseStore, holderKey, startLeaseHeartbeat, type LeaseHolder } from "./lease.js";

const TTL = 30_000;
let client: Client;
let clock: number;
const now = () => clock;
const store = () => new LeaseStore(client, { ttlMs: TTL, now });

/** One execution. Two subprocesses on one machine are two of these. */
const holder = (hostId: string, instanceId = "i1"): LeaseHolder => ({ hostId, instanceId });

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  clock = 1_000_000;
});

describe("acquisition", () => {
  it("grants a free lease", async () => {
    const lease = await store().acquire("card-1", holder("host-a"));
    expect(lease).toMatchObject({ cardId: "card-1", holder: holderKey(holder("host-a")), fence: 1 });
  });

  it("refuses a lease held by someone else", async () => {
    await store().acquire("card-1", holder("host-a"));
    expect(await store().acquire("card-1", holder("host-b"))).toBeNull();
  });

  it("refuses a second execution on the same host", async () => {
    await store().acquire("card-1", holder("host-a", "pid-100"));
    expect(await store().acquire("card-1", holder("host-a", "pid-200"))).toBeNull();
  });

  it("is idempotent for the same execution", async () => {
    const first = await store().acquire("card-1", holder("host-a", "pid-100"));
    const again = await store().acquire("card-1", holder("host-a", "pid-100"));
    expect(again?.holder).toBe(holderKey(holder("host-a", "pid-100")));
    expect(again!.fence).toBeGreaterThanOrEqual(first!.fence);
  });

  it("lets another host take over once the lease expires", async () => {
    await store().acquire("card-1", holder("host-a"));
    clock += TTL + 1;
    const taken = await store().acquire("card-1", holder("host-b"));
    expect(taken).toMatchObject({ holder: holderKey(holder("host-b")), fence: 2 });
  });
});

describe("two executions can never both hold one card", () => {
  it("admits exactly one winner among concurrent acquirers", async () => {
    const hosts = Array.from({ length: 12 }, (_, i) => holder(`host-${i}`));
    const results = await Promise.all(hosts.map((h) => store().acquire("card-hot", h)));
    const winners = results.filter((r) => r !== null);

    expect(winners).toHaveLength(1);
    const held = await store().get("card-hot");
    expect(winners[0]!.holder).toBe(held!.holder);
  });

  it("admits exactly one winner among concurrent subprocesses of one host", async () => {
    const instances = Array.from({ length: 8 }, (_, i) => holder("host-a", `pid-${i}`));
    const results = await Promise.all(instances.map((h) => store().acquire("card-hot", h)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("keeps admitting exactly one winner across repeated expiry handovers", async () => {
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all(
        ["host-a", "host-b", "host-c"].map((h) => store().acquire("card-1", holder(h))),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      clock += TTL + 1;
    }
  });
});

describe("fencing", () => {
  it("rejects renewal from a holder whose lease was revoked", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    await store().revoke("card-1");
    await store().acquire("card-1", holder("host-b"));

    // host-a is partitioned and still believes it holds the card.
    expect(await store().renew("card-1", holder("host-a"), lease.fence)).toBeNull();
    expect((await store().get("card-1"))!.holder).toBe(holderKey(holder("host-b")));
  });

  it("rejects renewal at a stale fence even for the same holder", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    clock += TTL + 1;
    await store().acquire("card-1", holder("host-a")); // fence advances
    expect(await store().renew("card-1", holder("host-a"), lease.fence)).toBeNull();
  });

  it("rejects release from a stale holder, so it cannot free the new holder's card", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    clock += TTL + 1;
    await store().acquire("card-1", holder("host-b"));

    expect(await store().release("card-1", holder("host-a"), lease.fence)).toBe(false);
    expect((await store().get("card-1"))!.holder).toBe(holderKey(holder("host-b")));
  });

  it("keeps the fence strictly increasing across a revocation", async () => {
    const first = (await store().acquire("card-1", holder("host-a")))!;
    await store().revoke("card-1");
    const second = (await store().acquire("card-1", holder("host-b")))!;
    expect(second.fence).toBeGreaterThan(first.fence);
  });

  it("keeps the fence strictly increasing across a release", async () => {
    const first = (await store().acquire("card-1", holder("host-a")))!;
    await store().release("card-1", holder("host-a"), first.fence);
    const second = (await store().acquire("card-1", holder("host-b")))!;
    expect(second.fence).toBeGreaterThan(first.fence);
  });

  it("refuses a write from a revoked holder that came back", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    await store().revoke("card-1");
    await store().acquire("card-1", holder("host-b"));

    await expect(store().assertHolds("card-1", holder("host-a"), lease.fence))
      .rejects.toBeInstanceOf(LeaseFenceError);
  });

  it("admits a write from the live holder at the current fence", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    await expect(store().assertHolds("card-1", holder("host-a"), lease.fence)).resolves.toBeUndefined();
  });

  it("refuses a write once the lease has been released", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    await store().release("card-1", holder("host-a"), lease.fence);
    await expect(store().assertHolds("card-1", holder("host-a"), lease.fence))
      .rejects.toBeInstanceOf(LeaseFenceError);
  });
});

describe("renewal", () => {
  it("pushes out the expiry for the live holder", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    clock += TTL / 2;
    const renewed = await store().renew("card-1", holder("host-a"), lease.fence);
    expect(renewed!.expiresAt).toBe(clock + TTL);
  });

  it("returns null for a card with no lease", async () => {
    expect(await store().renew("ghost", holder("host-a"), 1)).toBeNull();
  });
});

describe("release and revoke", () => {
  it("frees the card for the next acquirer", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    expect(await store().release("card-1", holder("host-a"), lease.fence)).toBe(true);
    expect(await store().acquire("card-1", holder("host-b")))
      .toMatchObject({ holder: holderKey(holder("host-b")) });
  });

  it("revoke frees the card regardless of holder, and keeps the fence history", async () => {
    await store().acquire("card-1", holder("host-a"));
    expect(await store().revoke("card-1")).toBe(true);
    // The row survives so the counter does; expiry zero is what "free" means.
    expect(await store().get("card-1")).toMatchObject({ expiresAt: 0 });
  });
});

describe("expiry sweep", () => {
  it("lists only leases past their expiry", async () => {
    await store().acquire("card-1", holder("host-a"));
    clock += TTL + 1;
    await store().acquire("card-2", holder("host-b"));

    const expired = await store().expired();
    expect(expired.map((l) => l.cardId)).toEqual(["card-1"]);
  });

  it("does not list a lease that was released, which nobody needs requeued", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    await store().release("card-1", holder("host-a"), lease.fence);
    clock += TTL + 1;
    expect(await store().expired()).toEqual([]);
  });
});

describe("heartbeat", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a card held for longer than one TTL", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    vi.useFakeTimers();
    const stop = startLeaseHeartbeat(store(), "card-1", holder("host-a"), lease.fence, { intervalMs: TTL / 3 });

    for (let tick = 0; tick < 4; tick++) {
      clock += TTL / 3;
      await vi.advanceTimersByTimeAsync(TTL / 3);
    }
    stop();

    // Past the original expiry, and still nobody else's to take.
    expect((await store().expired())).toEqual([]);
    expect(await store().acquire("card-1", holder("host-b"))).toBeNull();
  });

  it("says so once when the lease is no longer this holder's, and stops asking", async () => {
    const lease = (await store().acquire("card-1", holder("host-a")))!;
    vi.useFakeTimers();
    const lost: string[] = [];
    const stop = startLeaseHeartbeat(store(), "card-1", holder("host-a"), lease.fence, {
      intervalMs: TTL / 3,
      onLost: (reason) => lost.push(reason),
    });
    await store().revoke("card-1");

    for (let tick = 0; tick < 3; tick++) {
      clock += TTL / 3;
      await vi.advanceTimersByTimeAsync(TTL / 3);
    }
    stop();

    expect(lost).toHaveLength(1);
  });
});
