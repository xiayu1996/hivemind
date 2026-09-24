import { homedir } from "node:os";
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";

/** pi resolves its agent directory from this variable before falling back to ~/.pi/agent. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * How long pi's own lock has to be untouched before pi itself treats it as
 * abandoned. Reaping on the same threshold cannot steal a lock from a live
 * holder, because a live holder keeps refreshing its mtime.
 */
export const PI_AUTH_LOCK_STALE_MS = 30_000;

export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[AGENT_DIR_ENV];
  if (!configured) return join(homedir(), ".pi", "agent");
  return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured;
}

export function piAuthLockPath(env?: NodeJS.ProcessEnv): string {
  return join(piAgentDir(env), "auth.json.lock");
}

export interface AuthLockReap {
  reaped: boolean;
  /** Age of the lock that was found, for the log line explaining the wait. */
  ageMs: number | null;
}

/**
 * Removes an abandoned `auth.json.lock` before a spawn.
 *
 * pi locks the shared credential file while it refreshes an OAuth token, and a
 * process killed inside that window leaves the lock behind. The next pi then
 * blocks until the lock goes stale, which is longer than the handshake is
 * willing to wait, so the whole recovery path — watchdog kill, quarantine, a
 * host that simply died — would fail on its first attempt and look like a pi
 * that cannot start.
 *
 * Only a lock older than pi's own staleness threshold is removed. A younger one
 * belongs to a peer worker mid-refresh and is waited out, since breaking it
 * would let two processes rotate the same refresh token and invalidate each
 * other.
 */
export async function reapStalePiAuthLock(
  lockPath: string = piAuthLockPath(),
  options: { staleMs?: number; now?: () => number } = {},
): Promise<AuthLockReap> {
  const staleMs = options.staleMs ?? PI_AUTH_LOCK_STALE_MS;
  const now = options.now ?? Date.now;

  let ageMs: number;
  try {
    ageMs = now() - (await stat(lockPath)).mtimeMs;
  } catch {
    // No lock, which is the normal case: nothing to report.
    return { reaped: false, ageMs: null };
  }

  if (ageMs < staleMs) return { reaped: false, ageMs };
  await rm(lockPath, { recursive: true, force: true });
  return { reaped: true, ageMs };
}
