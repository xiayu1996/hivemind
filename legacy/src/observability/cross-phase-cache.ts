import type { Client } from "@libsql/client";
import { PHASE_LANE, type AgentPhase, type PhaseLane } from "../pipeline/phase.js";

/**
 * Prompt-cache accounting across the phases of one card.
 *
 * `analyzeCacheTurns` answers a different question: within one session, did the
 * provider keep serving the prefix it had just been sent. The money a card
 * loses is mostly elsewhere -- every phase is a new session, and the shared
 * baseline and repository context are re-billed at the uncached rate unless the
 * cache key, the retention window and the prefix order all line up.
 *
 * The place that shows is the first turn of each spawn: the turns after it are
 * warm from their own session and say nothing about the phase before. So the
 * cross-phase measure is the first turn's hit rate, per lane -- the builder and
 * the verifier route on different keys by design, and the verifier's own
 * numbers are naturally worse, so mixing them hides both.
 */

export interface PhaseTurn {
  runId: string;
  phase: AgentPhase;
  turn: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  startedAt: number;
}

export interface LaneCacheSummary {
  lane: PhaseLane;
  /** Phase runs seen in this lane, in the order they ran. */
  spawns: number;
  /** Spawns that had an earlier spawn in the same lane to reuse a prefix from.
   * The first one had nothing to hit and is excluded from the rate. */
  reusableSpawns: number;
  /** cacheRead over billed input on those spawns' first turns. This is the
   * number the cache key, retention and prefix order are all trying to move. */
  entryHitRate: number;
  /** The same ratio over every turn of the lane, for contrast: a high number
   * here with a low one above means the within-session cache works and the
   * cross-phase one does not. */
  overallHitRate: number;
  /** Reusable spawns that read nothing from cache at all, by phase. */
  coldEntries: AgentPhase[];
}

export interface CardCacheSummary {
  cardId: string;
  lanes: LaneCacheSummary[];
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function summarizeCrossPhaseCache(cardId: string, turns: readonly PhaseTurn[]): CardCacheSummary {
  const byLane = new Map<PhaseLane, PhaseTurn[]>();
  for (const turn of turns) {
    const lane = PHASE_LANE[turn.phase];
    const bucket = byLane.get(lane);
    if (bucket) bucket.push(turn);
    else byLane.set(lane, [turn]);
  }

  const lanes: LaneCacheSummary[] = [];
  for (const [lane, laneTurns] of [...byLane.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const ordered = [...laneTurns].toSorted((a, b) => a.startedAt - b.startedAt || a.turn - b.turn);
    const runOrder: string[] = [];
    for (const turn of ordered) if (!runOrder.includes(turn.runId)) runOrder.push(turn.runId);
    // The first turn of a spawn is the one that could have hit the phase
    // before it; a run whose first turn was never recorded contributes nothing.
    const entries = runOrder
      .map((runId) => ordered.find((turn) => turn.runId === runId && turn.turn === 1))
      .filter((turn): turn is PhaseTurn => turn !== undefined)
      .slice(1);
    let entryRead = 0;
    let entryBilled = 0;
    const coldEntries: AgentPhase[] = [];
    for (const entry of entries) {
      entryRead += entry.cacheRead;
      entryBilled += entry.input + entry.cacheRead + entry.cacheWrite;
      if (entry.cacheRead === 0) coldEntries.push(entry.phase);
    }
    let read = 0;
    let billed = 0;
    for (const turn of ordered) {
      read += turn.cacheRead;
      billed += turn.input + turn.cacheRead + turn.cacheWrite;
    }
    lanes.push({
      lane,
      spawns: runOrder.length,
      reusableSpawns: entries.length,
      entryHitRate: ratio(entryRead, entryBilled),
      overallHitRate: ratio(read, billed),
      coldEntries,
    });
  }
  return { cardId, lanes };
}

/** The card's recorded turns, oldest first. */
export async function loadCardTurns(client: Client, cardId: string): Promise<PhaseTurn[]> {
  const rows = (await client.execute({
    sql: `SELECT run_id, phase, turn, uncached_input_tokens, cache_read_tokens, cache_write_tokens, ts
            FROM turn_usage WHERE card_id = ? AND phase IS NOT NULL ORDER BY ts, turn`,
    args: [cardId],
  })).rows;
  return rows.map((row) => ({
    runId: String(row.run_id),
    phase: String(row.phase) as AgentPhase,
    turn: Number(row.turn),
    input: Number(row.uncached_input_tokens),
    cacheRead: Number(row.cache_read_tokens),
    cacheWrite: Number(row.cache_write_tokens),
    startedAt: Number(row.ts),
  }));
}
