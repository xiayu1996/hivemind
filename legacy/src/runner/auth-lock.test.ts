import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_AUTH_LOCK_STALE_MS, piAgentDir, piAuthLockPath, reapStalePiAuthLock } from "./auth-lock.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hm-authlock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function lock(ageMs: number): Promise<string> {
  const path = join(dir, "auth.json.lock");
  await mkdir(path);
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

describe("reapStalePiAuthLock", () => {
  it("removes a lock left behind by a process that was killed mid-refresh", async () => {
    const path = await lock(PI_AUTH_LOCK_STALE_MS + 5_000);

    expect((await reapStalePiAuthLock(path)).reaped).toBe(true);
    await expect(stat(path)).rejects.toThrow();
  });

  it("waits out a lock a peer worker still holds, rather than letting two processes rotate one token", async () => {
    const path = await lock(1_000);

    const result = await reapStalePiAuthLock(path);
    expect(result.reaped).toBe(false);
    expect(result.ageMs).toBeGreaterThanOrEqual(1_000);
    await expect(stat(path)).resolves.toBeDefined();
  });

  it("reports nothing when there is no lock at all", async () => {
    expect(await reapStalePiAuthLock(join(dir, "absent.lock"))).toEqual({ reaped: false, ageMs: null });
  });
});

describe("agent directory", () => {
  it("follows the variable pi itself reads", () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/srv/pi-agent" })).toBe("/srv/pi-agent");
    expect(piAuthLockPath({ PI_CODING_AGENT_DIR: "/srv/pi-agent" })).toBe("/srv/pi-agent/auth.json.lock");
  });

  it("falls back to the default location", () => {
    expect(piAgentDir({})).toMatch(/\.pi\/agent$/);
  });
});
