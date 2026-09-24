import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import {
  LeaseStore,
  startLeaseHeartbeat,
  type LeaseHolder,
} from "../persistence/lease.js";

/**
 * One daemon of each role per database.
 *
 * The orchestrator is the only writer of Notion and of every system-owned
 * field, and that single writer is the premise the whole store relies on to
 * skip conflict resolution. Nothing enforced it: the daemons are started by
 * hand, so a second start -- an operator's terminal, a restart that raced a
 * still-running process, a supervisor added later -- produced two writers in
 * silence. The invariant is one per *database* rather than one per host,
 * because two hosts pointed at the same store break it the same way, so the
 * store is where the claim has to live.
 *
 * It is the card lease with a reserved key, not a second locking scheme: the
 * conditional UPDATE decides the race, the monotonic fence stops a revoked
 * holder from renewing its way back in, and a holder that was killed outright
 * lapses after the TTL instead of locking the role out forever. A lock file
 * would have needed a liveness rule of its own, which is the failure mode
 * `auth.json.lock` already taught us to avoid.
 */

/** Reserved lease keys. The colon cannot appear in a card id, so a role can
 * never collide with a card that happens to be named after it. */
export const DAEMON_LEASE_KEYS = {
  orchestrator: "daemon:orchestrator",
  requirements: "daemon:requirements",
} as const;

export type DaemonRole = keyof typeof DAEMON_LEASE_KEYS;

/** How long a killed daemon keeps the role before another may take it. */
const DEFAULT_TTL_MS = 60_000;
/** Renewal cadence. Several ticks fit in one TTL, so a single failed renewal
 * (or one slow cycle) cannot lapse the claim. */
const DEFAULT_HEARTBEAT_MS = 15_000;

export class DaemonAlreadyRunningError extends Error {
  constructor(
    readonly role: DaemonRole,
    readonly holder: string,
    readonly expiresAt: number,
  ) {
    super(
      `another ${role} daemon holds this database: ${holder}. `
      + `It is the only writer of Notion and of the system-owned fields, so this one will not start. `
      + `Stop that process, or wait until ${new Date(expiresAt).toISOString()} if it is already gone.`,
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

export interface DaemonSingletonOptions {
  /** Called once if the claim is lost while running -- revoked, or lapsed
   * because renewals could not land. The caller stops writing; this module
   * never ends the process itself. */
  onLost: (reason: string) => void;
  hostId: string;
  /** New for every execution, so a second process on the same host is a
   * different holder and loses the race rather than joining it. */
  instanceId?: string;
  ttlMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

export interface DaemonSingleton {
  readonly key: string;
  readonly holder: LeaseHolder;
  readonly fence: number;
  /** Stops renewing and frees the role, so a restart does not wait out the TTL. */
  release(): Promise<void>;
}

/**
 * Claims the role or refuses to run.
 *
 * Throws `DaemonAlreadyRunningError` when another live daemon holds it. The
 * caller reports that and exits: a supervisor restarting the loser on a
 * throttle is the intended outcome, because the winner is serving.
 */
export async function holdDaemonSingleton(
  client: Client,
  role: DaemonRole,
  options: DaemonSingletonOptions,
): Promise<DaemonSingleton> {
  const key = DAEMON_LEASE_KEYS[role];
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const leaseOptions = options.now === undefined
    ? { ttlMs }
    : { ttlMs, now: options.now };
  const store = new LeaseStore(client, leaseOptions);
  const holder: LeaseHolder = {
    hostId: options.hostId,
    instanceId: options.instanceId ?? randomUUID(),
  };

  const lease = await store.acquire(key, holder);
  if (lease === null) {
    const held = await store.get(key);
    throw new DaemonAlreadyRunningError(
      role,
      held?.holder ?? "an unnamed holder",
      held?.expiresAt ?? 0,
    );
  }

  const stopHeartbeat = startLeaseHeartbeat(store, key, holder, lease.fence, {
    intervalMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    onLost: options.onLost,
  });

  return {
    key,
    holder,
    fence: lease.fence,
    async release(): Promise<void> {
      stopHeartbeat();
      await store.release(key, holder, lease.fence);
    },
  };
}
