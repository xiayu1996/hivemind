import type { Client } from "@libsql/client";
import type { CardSpend } from "../pipeline/cost-ceiling.js";
import type { TokenUsage } from "../runner/types.js";

export interface CostContext {
  runId: string;
  cardId?: string;
  phase?: string;
  purpose?: string;
  tier?: string;
  provider: string;
  modelId: string;
  hostId?: string;
  promptVersion?: string;
  isSubscription?: boolean;
}

export interface CostRecordedEvent {
  type: "cost.recorded";
  runId: string;
  data: CostContext & {
    uncachedInput: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    costUsd: number;
    ts: number;
  };
}

export interface CostEventSink {
  emit(event: CostRecordedEvent): Promise<void>;
}

function requireUsage(usage: TokenUsage): void {
  for (const [key, value] of Object.entries(usage)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`usage.${key} must be a non-negative number`);
  }
  if (usage.reasoning > usage.output) throw new Error("reasoning tokens cannot exceed output tokens");
}

function optional(context: CostContext, key: keyof CostContext): string | null {
  const value = context[key];
  return typeof value === "string" ? value : null;
}

/** Appends pi's own usage.cost value without recalculating provider prices. */
export class CostLedger {
  constructor(
    private readonly client: Client,
    private readonly events?: CostEventSink,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * What one card has spent, split by whether the money was actually metered.
   * The split is the point: subscription rows carry pi's notional price for a
   * flat-rate plan, so folding them in would charge a card for money nobody
   * spent and park it short of its real allowance.
   */
  async cardSpend(cardId: string): Promise<CardSpend> {
    const result = await this.client.execute({
      sql: `SELECT
              COALESCE(SUM(CASE WHEN is_subscription = 0 THEN cost_usd ELSE 0 END), 0) AS billed,
              COALESCE(SUM(CASE WHEN is_subscription = 1 THEN cost_usd ELSE 0 END), 0) AS subscription
            FROM cost_entries WHERE card_id = ?`,
      args: [cardId],
    });
    const row = result.rows[0];
    return {
      billedUsd: Number(row?.billed ?? 0),
      subscriptionUsd: Number(row?.subscription ?? 0),
    };
  }

  /** Metered spend per phase, for the report on a card that hit the ceiling. */
  async cardSpendByPhase(cardId: string): Promise<Map<string, number>> {
    const result = await this.client.execute({
      sql: `SELECT COALESCE(phase, 'unattributed') AS phase, SUM(cost_usd) AS usd
            FROM cost_entries WHERE card_id = ? AND is_subscription = 0
            GROUP BY COALESCE(phase, 'unattributed')`,
      args: [cardId],
    });
    return new Map(result.rows.map((row) => [String(row.phase), Number(row.usd ?? 0)]));
  }

  async record(context: CostContext, usage: TokenUsage): Promise<CostRecordedEvent> {
    requireUsage(usage);
    const ts = this.now();
    await this.client.execute({
      sql: `INSERT INTO cost_entries (
              run_id, card_id, phase, purpose, tier, provider, model_id, host_id,
              prompt_version, uncached_input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, reasoning_tokens, cost_usd, is_subscription, ts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        context.runId,
        optional(context, "cardId"),
        optional(context, "phase"),
        optional(context, "purpose"),
        optional(context, "tier"),
        context.provider,
        context.modelId,
        optional(context, "hostId"),
        optional(context, "promptVersion"),
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.reasoning,
        usage.costUsd,
        context.isSubscription ? 1 : 0,
        ts,
      ],
    });
    const event: CostRecordedEvent = {
      type: "cost.recorded",
      runId: context.runId,
      data: {
        ...context,
        uncachedInput: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        reasoning: usage.reasoning,
        costUsd: usage.costUsd,
        ts,
      },
    };
    await this.events?.emit(event);
    return event;
  }
}
