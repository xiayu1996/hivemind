import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialRefreshHolder, refreshCredentialsOnce } from "./auth-refresh.js";

let root: string;
let lockPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hivemind-auth-"));
  lockPath = join(root, "auth-refresh.lock");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;

describe("credential refresh", () => {
  it("lets only one of two concurrent callers refresh", async () => {
    // A rotated refresh token invalidates the one the other process is holding.
    let refreshes = 0;
    const gate = { release: () => {}, entered: () => {} };
    const held = new Promise<void>((resolve) => { gate.release = resolve; });
    const started = new Promise<void>((resolve) => { gate.entered = resolve; });
    const input = {
      lockPath,
      minIntervalMs: 60_000,
      now: () => NOW,
      lastRefreshedAt: async () => 0,
      refresh: async () => { refreshes++; gate.entered(); await held; },
    };

    const first = refreshCredentialsOnce(input);
    // The second caller arrives while the first is inside its refresh.
    await started;
    const second = await refreshCredentialsOnce(input);
    gate.release();

    expect(await first).toBe("refreshed");
    expect(second).toBe("busy");
    expect(refreshes).toBe(1);
  });

  it("skips a refresh that another process just completed", async () => {
    const outcome = await refreshCredentialsOnce({
      lockPath,
      minIntervalMs: 60_000,
      now: () => NOW,
      lastRefreshedAt: async () => NOW - 1_000,
      refresh: async () => { throw new Error("must not refresh"); },
    });
    expect(outcome).toBe("fresh");
  });

  it("releases the lock after a refresh so the next window can use it", async () => {
    const input = {
      lockPath,
      minIntervalMs: 0,
      now: () => NOW,
      lastRefreshedAt: async () => 0,
      refresh: async () => {},
    };
    expect(await refreshCredentialsOnce(input)).toBe("refreshed");
    expect(await credentialRefreshHolder(lockPath)).toBeNull();
    expect(await refreshCredentialsOnce(input)).toBe("refreshed");
  });

  it("reports a failed refresh without keeping the lock", async () => {
    const outcome = await refreshCredentialsOnce({
      lockPath,
      minIntervalMs: 0,
      now: () => NOW,
      lastRefreshedAt: async () => 0,
      refresh: async () => { throw new Error("credentials are not ready"); },
    });
    expect(outcome).toBe("failed");
    expect(await credentialRefreshHolder(lockPath)).toBeNull();
  });

  it("takes over a lock left behind by a process that died holding it", async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 1, at: NOW }));
    const outcome = await refreshCredentialsOnce({
      lockPath,
      minIntervalMs: 0,
      staleAfterMs: 1_000,
      now: () => NOW + 10_000,
      lastRefreshedAt: async () => 0,
      refresh: async () => {},
    });
    expect(outcome).toBe("refreshed");
  });
});
