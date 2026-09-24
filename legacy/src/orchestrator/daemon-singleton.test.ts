import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LeaseStore } from "../persistence/lease.js";
import { migrate } from "../persistence/migrate.js";
import {
  DAEMON_LEASE_KEYS,
  DaemonAlreadyRunningError,
  holdDaemonSingleton,
} from "./daemon-singleton.js";

const TTL = 60_000;
let client: Client;
let clock: number;
const now = (): number => clock;

const hold = (hostId: string, instanceId: string, role: "orchestrator" | "requirements" = "orchestrator") =>
  holdDaemonSingleton(client, role, {
    hostId,
    instanceId,
    ttlMs: TTL,
    heartbeatMs: 1_000,
    now,
    onLost: () => undefined,
  });

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  clock = 1_000_000;
});

describe("claiming a daemon role", () => {
  it("gives the role to the first daemon", async () => {
    const held = await hold("host-a", "pid-1");
    expect(held.key).toBe(DAEMON_LEASE_KEYS.orchestrator);
    expect(held.fence).toBeGreaterThan(0);
  });

  it("refuses a second daemon of the same role, naming the holder", async () => {
    await hold("host-a", "pid-1");
    await expect(hold("host-b", "pid-2")).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it("refuses a second daemon started on the same host", async () => {
    await hold("host-a", "pid-1");
    await expect(hold("host-a", "pid-2")).rejects.toThrow(/another orchestrator daemon holds this database/u);
  });

  it("keeps the two roles independent", async () => {
    await hold("host-a", "pid-1", "orchestrator");
    const requirements = await hold("host-a", "pid-1", "requirements");
    expect(requirements.key).toBe(DAEMON_LEASE_KEYS.requirements);
  });

  it("lets the next daemon in once a killed one has lapsed", async () => {
    await hold("host-a", "pid-1");
    clock += TTL + 1;
    const next = await hold("host-b", "pid-2");
    expect(next.key).toBe(DAEMON_LEASE_KEYS.orchestrator);
  });

  it("frees the role on release, without waiting out the lapse", async () => {
    const first = await hold("host-a", "pid-1");
    await first.release();
    const next = await hold("host-b", "pid-2");
    expect(next.fence).toBeGreaterThan(first.fence);
  });
});

describe("holding the role while running", () => {
  it("keeps renewing so a long cycle does not lose it", async () => {
    vi.useFakeTimers();
    try {
      await hold("host-a", "pid-1");
      const store = new LeaseStore(client, { ttlMs: TTL, now });
      const before = (await store.get(DAEMON_LEASE_KEYS.orchestrator))!.expiresAt;
      clock += 30_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await store.get(DAEMON_LEASE_KEYS.orchestrator))!.expiresAt).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a revoked claim so the daemon can stop writing", async () => {
    vi.useFakeTimers();
    const lost: string[] = [];
    try {
      await holdDaemonSingleton(client, "orchestrator", {
        hostId: "host-a",
        instanceId: "pid-1",
        ttlMs: TTL,
        heartbeatMs: 1_000,
        now,
        onLost: (reason) => lost.push(reason),
      });
      await new LeaseStore(client, { ttlMs: TTL, now }).revoke(DAEMON_LEASE_KEYS.orchestrator);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lost).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
