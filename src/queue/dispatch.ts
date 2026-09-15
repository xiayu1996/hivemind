import type { Client } from "@libsql/client";

/**
 * The set of cards a coordinator may hand out.
 *
 * The coordinator decides only *what may run*. It does not decide who runs a
 * card, nor on which provider or model: the subprocess claims the card by
 * lease and resolves its own agent spec per phase. So the one guarantee this
 * has to make is that it never offers a card somebody is already running --
 * including across its own restart, which is why the answer comes from the
 * lease table rather than from a map in this process.
 */

export interface DispatchQueueOptions {
  now?: () => number;
}

/** A card that is being executed right now, and by whom. */
export interface HeldCard {
  cardId: string;
  holder: string;
  expiresAt: number;
}

/**
 * Drops the cards a live lease already holds.
 *
 * An expired lease is not a holder: its worker is gone, and the card has to be
 * dispatchable again or a killed subprocess would park its card until somebody
 * noticed. A released or revoked lease keeps its row so the fence goes on
 * counting, and reads as free through the same comparison.
 */
export function dispatchableFrom(
  planned: readonly string[],
  held: readonly HeldCard[],
  now: number,
): string[] {
  const live = new Set(held.filter((lease) => lease.expiresAt > now).map((lease) => lease.cardId));
  return planned.filter((cardId) => !live.has(cardId));
}

export class DispatchQueue {
  private readonly now: () => number;

  constructor(private readonly client: Client, options: DispatchQueueOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Every card a live lease holds, whether or not this process started it. */
  async held(): Promise<HeldCard[]> {
    const now = this.now();
    const rows = (await this.client.execute({
      sql: "SELECT card_id, holder, expires_at FROM leases WHERE expires_at > ?",
      args: [now],
    })).rows;
    return rows.map((row) => ({
      cardId: String(row.card_id),
      holder: String(row.holder),
      expiresAt: Number(row.expires_at),
    }));
  }

  /**
   * Narrows a planned batch to the cards nobody is running.
   *
   * Order is the plan's own: the scheduler already ordered the batch by
   * priority within a set that is free of footprint conflicts, and dispatch
   * has no better ordering to offer.
   */
  async dispatchable(planned: readonly string[]): Promise<string[]> {
    if (planned.length === 0) return [];
    return dispatchableFrom(planned, await this.held(), this.now());
  }
}
