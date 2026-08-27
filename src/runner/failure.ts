import type { RpcEvent, RunFailure, TokenUsage } from "./types.js";

const EMPTY_USAGE: TokenUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0,
};

interface AssistantLike {
  stopReason?: unknown;
  errorMessage?: unknown;
  usage?: Record<string, unknown>;
}

function assistantMessagesIn(event: RpcEvent): AssistantLike[] {
  const out: AssistantLike[] = [];
  if (event.message && typeof event.message === "object") out.push(event.message as AssistantLike);
  if (Array.isArray(event.messages)) {
    for (const m of event.messages) if (m && typeof m === "object") out.push(m as AssistantLike);
  }
  return out;
}

/**
 * Extracts a provider failure from an event stream.
 *
 * pi has two distinct error surfaces. This covers the run-time one: an assistant
 * message with stopReason "error". Command-level rejections arrive as
 * `{type:"response", success:false}` and are handled where commands are sent.
 */
export function extractFailure(events: RpcEvent[]): RunFailure | null {
  let errorMessage: string | null = null;
  let willRetry: boolean | null = null;

  for (const event of events) {
    for (const message of assistantMessagesIn(event)) {
      if (message.stopReason === "error" && typeof message.errorMessage === "string" && errorMessage === null) {
        errorMessage = message.errorMessage;
      }
    }
    if (event.type === "agent_end" && typeof event.willRetry === "boolean") {
      willRetry = event.willRetry;
    }
  }

  return errorMessage === null ? null : { errorMessage, willRetry };
}

/**
 * Sums usage across a run.
 *
 * `reasoning` is a subset of `output` and is tracked separately for attribution
 * only; adding it to output would double-count. cacheRead and cacheWrite are
 * priced differently from uncached input, so they stay in their own buckets
 * rather than being folded into it.
 */
export function sumUsage(events: RpcEvent[]): TokenUsage {
  const total: TokenUsage = { ...EMPTY_USAGE };

  for (const event of events) {
    if (event.type !== "message_end") continue;
    for (const message of assistantMessagesIn(event)) {
      const usage = message.usage;
      if (!usage) continue;
      total.input += num(usage.input);
      total.output += num(usage.output);
      total.cacheRead += num(usage.cacheRead);
      total.cacheWrite += num(usage.cacheWrite);
      total.reasoning += num(usage.reasoning);
      const cost = usage.cost;
      if (cost && typeof cost === "object") total.costUsd += num((cost as Record<string, unknown>).total);
    }
  }

  return total;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
