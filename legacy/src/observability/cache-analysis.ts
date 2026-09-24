/**
 * Per-turn prompt-cache accounting for one model session.
 *
 * A single hit ratio over a whole run mixes two unrelated things: the structural
 * ceiling set by prefix size, per-turn growth and turn count, and genuine losses
 * where the provider failed to serve a prefix it had just been sent. Only the
 * second is a defect signal, so the two are reported separately.
 */

export interface TurnUsage {
  /** 1-based position of the assistant message in the session. */
  turn: number;
  /** Tokens billed at the uncached input rate. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface CacheLossEvent {
  turn: number;
  /** Tokens that were in the previous context but were not served from cache. */
  lostTokens: number;
  /** cacheRead / previous context, so a partial loss is distinguishable from a full one. */
  servedFraction: number;
}

export interface CacheAnalysis {
  turns: number;
  /** cacheRead / (input + cacheRead + cacheWrite) over the whole session. */
  actualHitRate: number;
  /** The same ratio if every turn had hit its entire previous context. */
  idealHitRate: number;
  /** Turns whose cache reads fell short of the previous context by more than the tolerance. */
  losses: CacheLossEvent[];
  lostTokens: number;
}

/**
 * Fraction of the previous context that must be served before a turn counts as
 * healthy. Providers report cache reads in blocks and the tail of the previous
 * response is not always cached yet, so an exact match is not expected.
 */
export const CACHE_LOSS_TOLERANCE = 0.9;

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function analyzeCacheTurns(turns: readonly TurnUsage[]): CacheAnalysis {
  let billedInput = 0;
  let cacheRead = 0;
  let idealMiss = 0;
  let idealRead = 0;
  let previousContext = 0;
  const losses: CacheLossEvent[] = [];

  for (const turn of turns) {
    const total = turn.input + turn.cacheRead + turn.cacheWrite;
    billedInput += total;
    cacheRead += turn.cacheRead;

    // Every token that was already in the context could have been served from
    // cache; what a perfect provider would still charge is only the new suffix.
    const servable = Math.min(previousContext, total);
    idealRead += servable;
    idealMiss += total - servable;

    if (previousContext > 0 && turn.cacheRead < previousContext * CACHE_LOSS_TOLERANCE) {
      losses.push({
        turn: turn.turn,
        lostTokens: previousContext - turn.cacheRead,
        servedFraction: ratio(turn.cacheRead, previousContext),
      });
    }
    previousContext = total + turn.output;
  }

  return {
    turns: turns.length,
    actualHitRate: ratio(cacheRead, billedInput),
    idealHitRate: ratio(idealRead, idealRead + idealMiss),
    losses,
    lostTokens: losses.reduce((sum, loss) => sum + loss.lostTokens, 0),
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Extracts per-turn usage from a pi message list. Only assistant messages carry
 * usage; anything without it is skipped rather than counted as a zero turn.
 */
export function turnUsageFromMessages(messages: readonly unknown[]): TurnUsage[] {
  const turns: TurnUsage[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; usage?: unknown };
    if (record.role !== "assistant" || typeof record.usage !== "object" || record.usage === null) continue;
    const usage = record.usage as Record<string, unknown>;
    turns.push({
      turn: turns.length + 1,
      input: num(usage.input),
      cacheRead: num(usage.cacheRead),
      cacheWrite: num(usage.cacheWrite),
      output: num(usage.output),
    });
  }
  return turns;
}

export interface ProviderDiagnostic {
  turn: number;
  diagnostics: unknown[];
}

/**
 * Collects the diagnostics pi attaches to assistant messages, such as a
 * WebSocket to SSE transport fallback. They explain a cache loss that would
 * otherwise look like provider randomness.
 */
export function diagnosticsFromMessages(messages: readonly unknown[]): ProviderDiagnostic[] {
  const found: ProviderDiagnostic[] = [];
  let turn = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; usage?: unknown; diagnostics?: unknown };
    if (record.role !== "assistant") continue;
    if (typeof record.usage === "object" && record.usage !== null) turn++;
    if (Array.isArray(record.diagnostics) && record.diagnostics.length > 0) {
      found.push({ turn, diagnostics: record.diagnostics });
    }
  }
  return found;
}
