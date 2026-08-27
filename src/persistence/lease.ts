import type { Client } from "@libsql/client";

export interface Lease {
  cardId: string;
  holder: string;
  fence: number;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
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
 * `fence` increases on every successful acquisition. A holder that was revoked
 * while partitioned still carries the old fence, so its later renewals and
 * releases are rejected instead of clobbering the new holder.
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
  async acquire(cardId: string, holder: string): Promise<Lease | null> {
    const now = this.now();
    const expiresAt = now + this.options.ttlMs;

    // Insert when absent; otherwise take over only from an expired lease or from
    // ourselves. The WHERE clause is the compare-and-swap.
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
      args: [cardId, holder, now, now, expiresAt, now, holder],
    });

    const lease = await this.get(cardId);
    return lease && lease.holder === holder ? lease : null;
  }

  /**
   * Extends the lease. Fails if the caller is no longer the holder or its fence
   * is stale, which is exactly the partitioned-worker case.
   */
  async renew(cardId: string, holder: string, fence: number): Promise<Lease | null> {
    const now = this.now();
    const result = await this.client.execute({
      sql: `UPDATE leases
               SET renewed_at = ?, expires_at = ?
             WHERE card_id = ? AND holder = ? AND fence = ?`,
      args: [now, now + this.options.ttlMs, cardId, holder, fence],
    });
    if (result.rowsAffected === 0) return null;
    return this.get(cardId);
  }

  /** Releases the lease only if this holder still owns it at this fence. */
  async release(cardId: string, holder: string, fence: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: "DELETE FROM leases WHERE card_id = ? AND holder = ? AND fence = ?",
      args: [cardId, holder, fence],
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
      sql: "DELETE FROM leases WHERE card_id = ?",
      args: [cardId],
    });
    return result.rowsAffected > 0;
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
      sql: "SELECT card_id, holder, fence, acquired_at, renewed_at, expires_at FROM leases WHERE expires_at <= ?",
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
