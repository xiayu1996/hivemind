import type { Client } from "@libsql/client";

/**
 * Ring 2: three scales, each reading only the one below it.
 *
 * run -> card -> fleet, and the direction is enforced by the types: `foldFleet`
 * takes card summaries and nothing else, so a fleet number can never be
 * computed by walking raw events again. That is what keeps the cost of the
 * widest view proportional to the number of cards rather than to the number of
 * events ever recorded, and it is why the fleet view can be rebuilt from
 * nothing in one pass.
 *
 * None of this is on the delivery path. Stop the process that computes it and
 * every card keeps moving; the only thing that stops is the reading.
 */

export interface RunSummary {
  runId: string;
  cardId: string;
  phase: string;
  round: number;
  status: "running" | "completed" | "failed";
  startedAt: number;
  endedAt: number | null;
  costUsd: number;
  cacheReadTokens: number;
  billedInputTokens: number;
}

export interface CardSummary {
  cardId: string;
  state: string;
  phase: string | null;
  runs: number;
  failedRuns: number;
  rounds: number;
  costUsd: number;
  /** Prompt-cache reuse over everything this card has spawned. */
  cacheHitRate: number;
  stopReason: string | null;
  lastRunAt: number | null;
}

export interface FleetSummary {
  cards: number;
  byState: Record<string, number>;
  costUsd: number;
  stoppedByReason: Record<string, number>;
  /** Cards with a failed phase run, worst first; the queue of things to look at. */
  worstCards: Array<{ cardId: string; failedRuns: number; costUsd: number }>;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function foldCard(input: {
  cardId: string;
  state: string;
  phase: string | null;
  stopReason: string | null;
  runs: readonly RunSummary[];
}): CardSummary {
  let costUsd = 0;
  let cacheRead = 0;
  let billed = 0;
  let failedRuns = 0;
  let rounds = 0;
  let lastRunAt: number | null = null;
  for (const run of input.runs) {
    costUsd += run.costUsd;
    cacheRead += run.cacheReadTokens;
    billed += run.billedInputTokens;
    if (run.status === "failed") failedRuns += 1;
    rounds = Math.max(rounds, run.round);
    lastRunAt = lastRunAt === null ? run.startedAt : Math.max(lastRunAt, run.startedAt);
  }
  return {
    cardId: input.cardId,
    state: input.state,
    phase: input.phase,
    runs: input.runs.length,
    failedRuns,
    rounds,
    costUsd,
    cacheHitRate: ratio(cacheRead, billed),
    stopReason: input.stopReason,
    lastRunAt,
  };
}

/** Reads finished card values only; there is deliberately no event parameter. */
export function foldFleet(cards: readonly CardSummary[]): FleetSummary {
  const byState: Record<string, number> = {};
  const stoppedByReason: Record<string, number> = {};
  let costUsd = 0;
  for (const card of cards) {
    byState[card.state] = (byState[card.state] ?? 0) + 1;
    costUsd += card.costUsd;
    if (card.stopReason) stoppedByReason[card.stopReason] = (stoppedByReason[card.stopReason] ?? 0) + 1;
  }
  const worstCards = cards
    .filter((card) => card.failedRuns > 0)
    .toSorted((a, b) => b.failedRuns - a.failedRuns || b.costUsd - a.costUsd || (a.cardId < b.cardId ? -1 : 1))
    .slice(0, 10)
    .map((card) => ({ cardId: card.cardId, failedRuns: card.failedRuns, costUsd: card.costUsd }));
  return { cards: cards.length, byState, costUsd, stoppedByReason, worstCards };
}

/** Run-scale rows for one card: the phase run joined to what it spent. */
export async function loadRunSummaries(client: Client, cardId: string): Promise<RunSummary[]> {
  const rows = (await client.execute({
    sql: `SELECT r.run_id, r.card_id, r.phase, r.round, r.status, r.started_at, r.ended_at,
                 COALESCE(SUM(c.cost_usd), 0) AS cost_usd,
                 COALESCE(SUM(c.cache_read_tokens), 0) AS cache_read,
                 COALESCE(SUM(c.uncached_input_tokens + c.cache_read_tokens + c.cache_write_tokens), 0) AS billed
            FROM phase_runs r LEFT JOIN cost_entries c ON c.run_id = r.run_id
           WHERE r.card_id = ?
           GROUP BY r.run_id ORDER BY r.started_at`,
    args: [cardId],
  })).rows;
  return rows.map((row) => ({
    runId: String(row.run_id),
    cardId: String(row.card_id),
    phase: String(row.phase),
    round: Number(row.round),
    status: String(row.status) as RunSummary["status"],
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    costUsd: Number(row.cost_usd),
    cacheReadTokens: Number(row.cache_read),
    billedInputTokens: Number(row.billed),
  }));
}

export async function loadCardSummary(client: Client, cardId: string): Promise<CardSummary | null> {
  const story = (await client.execute({
    sql: "SELECT id, state, phase, stop_reason FROM stories WHERE id = ?",
    args: [cardId],
  })).rows[0];
  if (!story) return null;
  return foldCard({
    cardId,
    state: String(story.state),
    phase: story.phase === null ? null : String(story.phase),
    stopReason: story.stop_reason === null ? null : String(story.stop_reason),
    runs: await loadRunSummaries(client, cardId),
  });
}
