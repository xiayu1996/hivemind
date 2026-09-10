import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * One refresher for the shared credential file.
 *
 * Every pi process on a host reads and writes the same `~/.pi/agent/auth.json`,
 * and an OAuth refresh rotates the token: the provider invalidates the old one
 * the moment a new one is issued. Two processes refreshing within the same
 * second therefore invalidate each other and both end up with a token the
 * provider rejects ("Your refresh token has already been used"), which reaches
 * the pipeline as a 401 mid-phase. So exactly one process refreshes, and it
 * says so in a lock file the others can see.
 */
export interface CredentialRefreshInput {
  /** Lock file path. Its directory is created if missing. */
  lockPath: string;
  /** Performs the refresh. Only ever called by the lock holder. */
  refresh: () => Promise<void>;
  /** When the credentials were last written, so a caller that arrives right
   * after a refresh does not spend another one. */
  lastRefreshedAt: () => Promise<number>;
  minIntervalMs: number;
  /** A lock older than this belonged to a process that died holding it. */
  staleAfterMs?: number;
  now?: () => number;
}

export type CredentialRefreshOutcome = "refreshed" | "fresh" | "busy" | "failed";

const DEFAULT_STALE_AFTER_MS = 120_000;

async function takeLock(lockPath: string, at: number, staleAfterMs: number): Promise<boolean> {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at }));
    } finally {
      await handle.close();
    }
    return true;
  } catch (cause) {
    if ((cause as { code?: string }).code !== "EEXIST") throw cause;
  }
  const holder = await credentialRefreshHolder(lockPath);
  let heldSince: number;
  if (holder) {
    // The holder stamped the lock from the same clock this caller reads, so a
    // test clock and a real one never end up compared against each other.
    heldSince = holder.at;
  } else {
    try {
      heldSince = (await stat(lockPath)).mtimeMs;
    } catch {
      // Released between our create and our stat; the next caller takes it.
      // Reporting busy costs one poll interval and never a double refresh.
      return false;
    }
  }
  if (at - heldSince < staleAfterMs) return false;
  // The holder died with the lock: whoever removes it first takes it.
  await rm(lockPath, { force: true });
  return takeLock(lockPath, at, staleAfterMs);
}

/**
 * Refreshes the credentials at most once per `minIntervalMs` across every
 * process on the host. "busy" and "fresh" are both normal: they mean someone
 * else's refresh is the one that counts, not that this caller failed.
 */
export async function refreshCredentialsOnce(input: CredentialRefreshInput): Promise<CredentialRefreshOutcome> {
  const now = input.now ?? Date.now;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (now() - (await input.lastRefreshedAt()) < input.minIntervalMs) return "fresh";
  if (!(await takeLock(input.lockPath, now(), staleAfterMs))) return "busy";
  try {
    // Re-read under the lock: the holder we queued behind may have just done it.
    if (now() - (await input.lastRefreshedAt()) < input.minIntervalMs) return "fresh";
    await input.refresh();
    return "refreshed";
  } catch {
    // A failed refresh is the credential probe's news to report, not this
    // module's: it owns who refreshes, not what a bad credential means.
    return "failed";
  } finally {
    await rm(input.lockPath, { force: true });
  }
}

/** Who holds the lock, for an operator looking at a host that is not refreshing. */
export async function credentialRefreshHolder(lockPath: string): Promise<{ pid: number; at: number } | null> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; at: number };
  } catch {
    // No lock file, or one written by a process that died mid-write.
    return null;
  }
}
