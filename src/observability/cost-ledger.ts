import type { Client } from "@libsql/client";
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
