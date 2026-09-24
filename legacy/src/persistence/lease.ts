import type { Client } from "@libsql/client";

export interface Lease {
  cardId: string;
  holder: string;
  fence: number;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
}

/**
 * Who holds a lease. The host alone is not an identity: two `story:run`
 * subprocesses on one machine would both match the "already ours" branch of
 * the acquisition and both start the card. The instance is what distinguishes
 * them, and it must be new for every execution.
 */
export interface LeaseHolder {
  hostId: string;
  instanceId: string;
}

export function holderKey(holder: LeaseHolder): string {
  return `${holder.hostId}#${holder.instanceId}`;
}

/** A lease identity a write can be checked against. */
export interface LeaseFence {
  holder: string;
  fence: number;
}

export class LeaseFenceError extends Error {
  constructor(readonly cardId: string, message: string) {
    super(`lease fence check failed for ${cardId}: ${message}`);
    this.name = "LeaseFenceError";
  }
}

export interface LeaseOptions {
  ttlMs: number;
  now?: () => number;
}

/**
 * Card-level leases in the central store.
 *
 * A card is sticky to one host for its whole life, so the lease — not the queue
 * job — is what makes double execution impossible. Every mutation is a
 * conditional UPDATE whose WHERE clause carries the caller's assumption, so two
 * racing writers cannot both believe they won: SQLite serialises the writes and
 * the loser's WHERE no longer matches.
 *
 * `fence` increases on every successful acquisition and never goes backwards,
 * including across a release or a revocation. That is why a released lease
 * keeps its row and is marked expired rather than deleted: deleting it reset
 * the counter to 1, and revocation is used in exactly the situation where the
 * old holder is most likely to come back -- it would return with fence 1 and
 * match the new holder's fence 1.
 */
export class LeaseStore {
  private readonly now: () => number;

  constructor(private readonly client: Client, private readonly options: LeaseOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Takes the lease if it is free, expired, or already held by this holder.
   * Returns null when another live holder has it.
   */
  async acquire(cardId: string, holder: LeaseHolder): Promise<Lease | null> {
    const now = this.now();
    const expiresAt = now + this.options.ttlMs;
    const key = holderKey(holder);

    // Insert when absent; otherwise take over only from an expired lease or
    // from this same execution instance. The WHERE clause is the
    // compare-and-swap, and the fence always moves forward.
    await this.client.execute({
      sql: `INSERT INTO leases (card_id, holder, fence, acquired_at, renewed_at, expires_at)
            VALUES (?, ?, 1, ?, ?, ?)
            ON CONFLICT(card_id) DO UPDATE SET
              holder      = excluded.holder,
              fence       = leases.fence + 1,
              acquired_at = excluded.acquired_at,
              renewed_at  = excluded.renewed_at,
              expires_at  = excluded.expires_at
            WHERE leases.expires_at <= ? OR leases.holder = ?`,
      args: [cardId, key, now, now, expiresAt, now, key],
    });

    const lease = await this.get(cardId);
    return lease && lease.holder === key ? lease : null;
  }

  /**
   * Extends the lease. Fails if the caller is no longer the holder or its fence
   * is stale, which is exactly the partitioned-worker case.
   */
  async renew(cardId: string, holder: LeaseHolder, fence: number): Promise<Lease | null> {
    const now = this.now();
    const result = await this.client.execute({
      sql: `UPDATE leases
               SET renewed_at = ?, expires_at = ?
             WHERE card_id = ? AND holder = ? AND fence = ? AND expires_at > 0`,
      args: [now, now + this.options.ttlMs, cardId, holderKey(holder), fence],
    });
    if (result.rowsAffected === 0) return null;
    return this.get(cardId);
  }

  /** Releases the lease only if this holder still owns it at this fence. The
   * row stays so the fence keeps counting; expiry zero means free. */
  async release(cardId: string, holder: LeaseHolder, fence: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: "UPDATE leases SET expires_at = 0 WHERE card_id = ? AND holder = ? AND fence = ? AND expires_at > 0",
      args: [cardId, holderKey(holder), fence],
    });
    return result.rowsAffected > 0;
  }

  /**
   * Orchestrator-side revocation, used when a worker has been unreachable past
   * the grace period. Unconditional by design: the point is to take the card away
   * from a holder that cannot be reasoned with.
   */
  async revoke(cardId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "UPDATE leases SET expires_at = 0 WHERE card_id = ? AND expires_at > 0",
      args: [cardId],
    });
    return result.rowsAffected > 0;
  }

  /**
   * Whether this identity may still write on the card's behalf. Every state and
   * artifact write goes through it: the lease is what stops double execution,
   * and until now nothing outside this file had ever looked at a fence, so a
   * revoked holder coming back could still write.
   */
  async assertHolds(cardId: string, holder: LeaseHolder, fence: number): Promise<void> {
    const lease = await this.get(cardId);
    if (!lease) throw new LeaseFenceError(cardId, "the card holds no lease");
    if (lease.expiresAt === 0) throw new LeaseFenceError(cardId, "the lease was released or revoked");
    const key = holderKey(holder);
    if (lease.holder !== key) throw new LeaseFenceError(cardId, `held by ${lease.holder}, not ${key}`);
    if (lease.fence !== fence) throw new LeaseFenceError(cardId, `fence is ${lease.fence}, not ${fence}`);
  }

  async get(cardId: string): Promise<Lease | null> {
    const row = (await this.client.execute({
      sql: "SELECT card_id, holder, fence, acquired_at, renewed_at, expires_at FROM leases WHERE card_id = ?",
      args: [cardId],
    })).rows[0];
    if (!row) return null;
    return {
      cardId: String(row.card_id),
      holder: String(row.holder),
      fence: Number(row.fence),
      acquiredAt: Number(row.acquired_at),
      renewedAt: Number(row.renewed_at),
      expiresAt: Number(row.expires_at),
    };
  }

  /** Leases past their expiry: candidates for requeue by the orchestrator. */
  async expired(): Promise<Lease[]> {
    const rows = (await this.client.execute({
      sql: "SELECT card_id, holder, fence, acquired_at, renewed_at, expires_at FROM leases WHERE expires_at > 0 AND expires_at <= ?",
      args: [this.now()],
    })).rows;
    return rows.map((row) => ({
      cardId: String(row.card_id),
      holder: String(row.holder),
      fence: Number(row.fence),
      acquiredAt: Number(row.acquired_at),
      renewedAt: Number(row.renewed_at),
      expiresAt: Number(row.expires_at),
    }));
  }
}

export interface LeaseHeartbeatOptions {
  /** How often to renew. Must be well under the TTL: one missed renewal has to
   * leave time for the next one before the lease lapses. */
  intervalMs: number;
  /** Called once when a renewal is refused, which means this holder no longer
   * owns the card. Every subsequent write is refused by `assertHolds`, so this
   * is a report, not the enforcement. */
  onLost?: (reason: string) => void;
}

/**
 * Keeps a held lease alive for as long as the phase runs.
 *
 * `acquire` gives a card away for one TTL. A phase that runs longer than that
 * -- CODE routinely does -- outlives its own lease, and the card becomes
 * dispatchable again while its subprocess is still working in the worktree.
 * On one host the coordinator's in-flight map hides this; across hosts nothing
 * does, and that is precisely the double execution the lease exists to make
 * impossible.
 *
 * Returns the function that stops it. The timer is unref'd, so it never keeps
 * the process alive by itself.
 */
export function startLeaseHeartbeat(
  store: LeaseStore,
  cardId: string,
  holder: LeaseHolder,
  fence: number,
  options: LeaseHeartbeatOptions,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      if (stopped) return;
      try {
        const renewed = await store.renew(cardId, holder, fence);
        if (renewed === null) {
          stopped = true;
          clearInterval(timer);
          options.onLost?.("the lease was taken, revoked or released");
        }
      } catch {
        // A store fault is not a lost lease, and reporting it as one would send
        // a healthy run looking for a holder that never changed. The interval
        // is a fraction of the TTL, so there are several more ticks before the
        // lease could actually lapse; nothing else can reach this catch.
      }
    })();
  }, options.intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
