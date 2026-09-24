import type { AlertRouter } from "../alert/index.js";
import { alertNeedsInput } from "../alert/story-alerts.js";
import { renderStopSummary, type StopSummary } from "./stop-summary.js";

export interface StoryStopSink {
  /** Called once, after the card is already stopped in the database. */
  onStoryStopped(summary: StopSummary): Promise<void>;
}

/**
 * Tells everything that wants to know that a card stopped.
 *
 * One sink failing must not keep the others from hearing: a card that stopped
 * has stopped whether or not the alert channel accepted it, and the whole
 * point of this hook is that the record and the notification stop being two
 * independent implementations of the same thing.
 */
export async function notifyStoryStopped(
  sinks: readonly StoryStopSink[],
  summary: StopSummary,
): Promise<{ failed: string[] }> {
  const results = await Promise.allSettled(sinks.map((sink) => sink.onStoryStopped(summary)));
  return {
    failed: results.flatMap((result, index) =>
      result.status === "rejected" ? [`${sinks[index]?.constructor.name ?? index}: ${String(result.reason)}`] : []),
  };
}

/** The mandatory out-of-band notification, with the whole summary as its body. */
export class AlertStopSink implements StoryStopSink {
  constructor(private readonly alerts: AlertRouter) {}

  async onStoryStopped(summary: StopSummary): Promise<void> {
    await alertNeedsInput(
      this.alerts,
      { id: summary.cardId, state: "NEEDS_INPUT", stopReason: summary.reason },
      renderStopSummary(summary),
    );
  }
}

export interface FrictionSink {
  record(input: { cardId: string; runId: string; kind: string; detail: string }): Promise<void>;
}

/**
 * The input to the reflection pipeline (03 section 4).
 *
 * A spend stop is deliberately not recorded: reaching a money ceiling says
 * nothing about whether the work is achievable or whether the machinery around
 * it is sound, and feeding it into the pipeline that looks for process defects
 * would put a price tag where a diagnosis should be.
 */
export class FrictionStopSink implements StoryStopSink {
  constructor(private readonly friction: FrictionSink) {}

  async onStoryStopped(summary: StopSummary): Promise<void> {
    if (summary.reason === "cost_ceiling_exceeded") return;
    await this.friction.record({
      cardId: summary.cardId,
      runId: `stop-${summary.cardId}`,
      kind: "story_stopped",
      detail: JSON.stringify({
        reason: summary.reason,
        ...(summary.convergence ? { classification: summary.convergence } : {}),
        ...(summary.diagnosis ? { side: summary.diagnosis.side } : {}),
        spent: summary.spent,
        budget: summary.budget,
      }),
    });
  }
}
