import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import type { ModelPurpose } from "../pipeline/phase.js";

/**
 * Per-provider concurrency, taken per spawn.
 *
 * One account throttles concurrent streams -- roughly two to three before it
 * starts returning 429 with no `Retry-After` to back off on -- so the binding
 * limit is per provider, not per host. A slot is taken immediately before a
 * real spawn and given back when it ends, which is what makes a failover to
 * another provider release the first one's capacity.
 *
 * Waiting for a slot is a scheduling state: it costs no failure round, produces
 * no stop point, and the card is still held by its lease while it waits.
 */

export interface ProviderSlot {
  slotId: string;
  provider: string;
  cardId: string;
  holder: string;
  expiresAt: number;
}

export interface ProviderSlotOptions {
  /** How long a slot survives without a heartbeat. A holder that is killed
   * gives its capacity back after this, with nobody having to sweep. */
  leaseMs: number;
  now?: () => number;
}

/** The conservative capacity for a provider nobody configured. A subscription
 * is the tighter of the two because its limit is an undocumented account-level
 * throttle rather than a published rate. */
export function defaultCapacity(authType: "api_key" | "oauth"): number {
  return authType === "oauth" ? 2 : 4;
}

export class ProviderSlotStore {
  private readonly now: () => number;

  constructor(private readonly client: Client, private readonly options: ProviderSlotOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Takes a slot if the provider has one free, in a single statement so two
   * subprocesses cannot both read "one free" and both take it. Returns null
   * when the bucket is full; the caller waits and asks again.
   */
  async acquire(input: {
    provider: string;
    cardId: string;
    holder: string;
    purpose: ModelPurpose;
    capacity: number;
  }): Promise<ProviderSlot | null> {
    const now = this.now();
    const expiresAt = now + this.options.leaseMs;
    const slotId = randomUUID();
    const result = await this.client.execute({
      sql: `INSERT INTO provider_slots (slot_id, provider, card_id, holder, purpose, acquired_at, heartbeat_at, expires_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?
            WHERE (SELECT COUNT(*) FROM provider_slots WHERE provider = ? AND expires_at > ?) < ?`,
      args: [slotId, input.provider, input.cardId, input.holder, input.purpose, now, now, expiresAt,
             input.provider, now, input.capacity],
    });
    if (result.rowsAffected === 0) return null;
    return { slotId, provider: input.provider, cardId: input.cardId, holder: input.holder, expiresAt };
  }

  /** Keeps a long phase's slot alive; a phase can outrun the lease window. */
  async heartbeat(slotId: string): Promise<boolean> {
    const now = this.now();
    const result = await this.client.execute({
      sql: "UPDATE provider_slots SET heartbeat_at = ?, expires_at = ? WHERE slot_id = ?",
      args: [now, now + this.options.leaseMs, slotId],
    });
    return result.rowsAffected > 0;
  }

  async release(slotId: string): Promise<void> {
    await this.client.execute({ sql: "DELETE FROM provider_slots WHERE slot_id = ?", args: [slotId] });
  }

  /** Everything this execution still holds, for a crash-safe cleanup on exit. */
  async releaseHolder(holder: string): Promise<void> {
    await this.client.execute({ sql: "DELETE FROM provider_slots WHERE holder = ?", args: [holder] });
  }

  /** Live slots per provider, for the console and for capacity decisions. */
  async inFlight(): Promise<Map<string, number>> {
    const rows = (await this.client.execute({
      sql: "SELECT provider, COUNT(*) AS live FROM provider_slots WHERE expires_at > ? GROUP BY provider",
      args: [this.now()],
    })).rows;
    return new Map(rows.map((row) => [String(row.provider), Number(row.live)]));
  }

  /** Drops rows whose holder stopped heartbeating. Capacity is already back --
   * the count only looks at live rows -- so this is housekeeping, not recovery. */
  async reapExpired(): Promise<number> {
    const result = await this.client.execute({
      sql: "DELETE FROM provider_slots WHERE expires_at <= ?",
      args: [this.now()],
    });
    return result.rowsAffected;
  }
}
