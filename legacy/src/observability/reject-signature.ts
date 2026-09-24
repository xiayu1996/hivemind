import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { normalizeFailureText } from "../regression/verdict.js";

/**
 * Why work gets sent back, counted across cards.
 *
 * One card being rejected twice for the same reason is visible to whoever reads
 * that card. The same reason appearing on nine cards is not visible anywhere,
 * and it is the more valuable of the two: it names a hole in the contract or
 * the prompt rather than a bad round. So the reasons are normalised the same
 * way a regression failure is -- paths, line numbers, ids and durations are
 * what differ between two instances of one problem -- and ranked by how many
 * distinct cards they touched.
 *
 * A projection: nothing here is on the delivery path, and the numbers can be
 * rebuilt from the event log at any time.
 */

export interface RejectionEvent {
  cardId: string;
  phase: string | null;
  round: number | null;
  reason: string;
  at: number;
}

export interface RejectionGroup {
  signature: string;
  /** The normalised text the grouping was done on, so a reader can see why
   * these were treated as one thing. */
  canonical: string;
  /** One real example, unnormalised. */
  example: string;
  occurrences: number;
  cards: string[];
  phases: string[];
  lastSeenAt: number;
}

/**
 * One step coarser than a regression signature, and deliberately so. A
 * regression names a break in a particular file, so the file belongs in its
 * identity. A rejection is a reason work came back, and the same reason lands
 * on a different file every time -- keeping the name would split one systemic
 * problem into one group per card, which is exactly the view that already
 * exists and already fails to show it.
 */
export function rejectionSignature(reason: string): { signature: string; canonical: string } {
  const canonical = normalizeFailureText(reason).replaceAll(/\b[\w-]+\.[a-z]{1,4}\b/g, "<file>");
  return { signature: createHash("sha256").update(canonical).digest("hex").slice(0, 32), canonical };
}

/** Ranked by cards affected, then occurrences: a reason that hit many cards
 * outranks one that hit a single card many times. */
export function rankRejections(events: readonly RejectionEvent[]): RejectionGroup[] {
  const groups = new Map<string, RejectionGroup>();
  for (const event of events) {
    const { signature, canonical } = rejectionSignature(event.reason);
    const existing = groups.get(signature);
    if (!existing) {
      groups.set(signature, {
        signature,
        canonical,
        example: event.reason,
        occurrences: 1,
        cards: [event.cardId],
        phases: event.phase ? [event.phase] : [],
        lastSeenAt: event.at,
      });
      continue;
    }
    existing.occurrences += 1;
    if (!existing.cards.includes(event.cardId)) existing.cards.push(event.cardId);
    if (event.phase && !existing.phases.includes(event.phase)) existing.phases.push(event.phase);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, event.at);
  }
  for (const group of groups.values()) {
    group.cards.sort();
    group.phases.sort();
  }
  return [...groups.values()].toSorted((a, b) =>
    b.cards.length - a.cards.length
    || b.occurrences - a.occurrences
    || (a.signature < b.signature ? -1 : 1));
}

/** Every rejection the event log holds: a phase invalidated by the contract
 * checks or by a person, and the friction the worker recorded on its own. */
export async function loadRejections(client: Client, options: { since?: number } = {}): Promise<RejectionEvent[]> {
  const rows = (await client.execute({
    sql: `SELECT card_id, phase, type, ts, data FROM event_log
           WHERE type IN ('phase.invalidated', 'friction.recorded')
             AND card_id IS NOT NULL AND ts >= ?
           ORDER BY ts, id`,
    args: [options.since ?? 0],
  })).rows;
  const events: RejectionEvent[] = [];
  for (const row of rows) {
    const data = JSON.parse(String(row.data)) as { reason?: unknown; detail?: unknown; kind?: unknown; round?: unknown };
    const reason = typeof data.reason === "string"
      ? data.reason
      : typeof data.detail === "string"
        ? `${typeof data.kind === "string" ? `${data.kind}: ` : ""}${data.detail}`
        : null;
    if (!reason) continue;
    events.push({
      cardId: String(row.card_id),
      phase: row.phase === null ? null : String(row.phase),
      round: typeof data.round === "number" ? data.round : null,
      reason,
      at: Number(row.ts),
    });
  }
  return events;
}
