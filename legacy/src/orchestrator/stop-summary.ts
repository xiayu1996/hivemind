import { diagnoseRetryLimit, renderRetryReport, type RetryDiagnosis } from "../pipeline/retry-limits.js";
import { renderConvergenceReport, type ConvergenceClassification } from "../pipeline/convergence.js";
import type { StoryStopReason } from "./state-machine.js";

/** One verification round, as the card recorded it. */
export interface StopSummaryRound {
  round: number;
  failed: readonly string[];
  /** Why each scenario was refused, in the words of the lane that refused it. */
  reasons: readonly { scenarioId: string; reason: string; detail?: string }[];
}

export interface StopSummaryMergeBounce {
  attribution: "story_regression" | "conflict";
  check?: string;
  failures: readonly string[];
}

export interface StopSummaryBaselineFailure {
  check: string;
  failures: readonly string[];
}

export interface StopSummaryDispatchFailure {
  state: string;
  errorClass: string;
  message: string;
  /** Set when the run died of its own phase exit rather than of something
   * nobody can place; it is what the person reads instead of the message. */
  refusal?: { gate: string; detail: string };
}

/**
 * Everything the rounds since the last human action added up to.
 *
 * A stopped card used to offer one word - "retry limit exceeded" - over a
 * history nobody could see without reading the event log by hand. Every field
 * here already existed somewhere; what was missing was one place that holds
 * them together at the moment the card stops, so the page, the alert and the
 * friction record all say the same thing.
 */
export interface StopSummary {
  cardId: string;
  reason: StoryStopReason;
  /** Which situation ended the loop, when a loop ended it. */
  convergence?: ConvergenceClassification;
  spent: number;
  /**
   * Absent when the stop did not come from a round budget. It used to default
   * to 0, which reads as a budget of zero -- a number the code guarantees
   * cannot exist, since `maxInnerLoopRounds` is validated above zero.
   */
  budget?: number;
  /**
   * Rounds that reached no verdict: the box would not stand up, or the
   * situation a scenario is judged in could not be produced at all.
   *
   * Kept out of `rounds` because an inconclusive round judges no code and must
   * not enter the convergence curve, and carried whatever ended the card
   * rather than only when the inconclusive count did. S-R237511MB-02 stopped
   * on its reopen budget with two of these behind it, each saying in a full
   * sentence that no browser it could reach comes from outside the allowed
   * networks, and the person it stopped for was shown none of it.
   */
  inconclusive?: {
    attempts: number;
    scenarios: readonly string[];
    rounds: readonly StopSummaryRound[];
  };
  rounds: readonly StopSummaryRound[];
  mergeBounces: readonly StopSummaryMergeBounce[];
  baselineFailures: readonly StopSummaryBaselineFailure[];
  /** Phase exits that refused what the round produced, newest first. */
  refusals: readonly { phase: string; reason: string }[];
  /** Runs that died before they produced anything. */
  dispatchFailures: readonly StopSummaryDispatchFailure[];
  costUsd: number;
  /** Absent for a spend stop: it says nothing about whether the work is doable. */
  diagnosis?: RetryDiagnosis;
}

/** Scenarios that failed in every round; the requirement's own suspects. */
export function neverPassed(summary: StopSummary): string[] {
  return summary.diagnosis?.persistent ? [...summary.diagnosis.persistent] : [];
}

/** Scenarios that passed in one round and broke again later. */
export function passedThenFailed(summary: StopSummary): string[] {
  return summary.diagnosis?.regressed ? [...summary.diagnosis.regressed] : [];
}

/**
 * The operator-facing rendering, for the console and the out-of-band alert.
 * What a person sees on the Notion card is rendered separately and in Chinese;
 * this one is read beside logs.
 */
export function renderStopSummary(summary: StopSummary): string {
  const history = summary.rounds.map((round) => round.failed);
  const lines: string[] = [];
  if (summary.reason === "cost_ceiling_exceeded") {
    lines.push(`${summary.cardId} stopped: it reached the spend a single card is allowed`);
  } else if (summary.diagnosis) {
    lines.push(renderRetryReport(summary.cardId, summary.reason, summary.diagnosis).trimEnd());
  } else if (summary.convergence) {
    lines.push(renderConvergenceReport(summary.cardId, summary.convergence, history).trimEnd());
  } else {
    lines.push(`${summary.cardId} stopped: ${summary.reason}`);
  }
  if (summary.inconclusive) {
    lines.push(
      "",
      `No round reached a verdict, ${summary.inconclusive.attempts} in a row: `
      + summary.inconclusive.scenarios.join(", "),
    );
    // The count names no decision. What a person has to decide on is the
    // reason -- a box that would not start is theirs to repair, a situation no
    // browser of ours can be in is theirs to move out of the screen lane --
    // so the latest reason per scenario is printed beneath it.
    const latest = new Map<string, string>();
    for (const round of summary.inconclusive.rounds) {
      for (const entry of round.reasons) latest.set(entry.scenarioId, entry.reason);
    }
    for (const [scenarioId, reason] of [...latest].toSorted(([left], [right]) => left.localeCompare(right))) {
      lines.push(`  ${scenarioId}: ${reason}`);
    }
  }
  lines.push("", summary.budget === undefined
    ? `Rounds spent: ${summary.spent}`
    : `Rounds spent: ${summary.spent} of ${summary.budget}`);
  for (const bounce of summary.mergeBounces) {
    lines.push(`Merge sent it back (${bounce.attribution}): ${bounce.failures.join(", ") || bounce.check || "no name recorded"}`);
  }
  for (const baseline of summary.baselineFailures) {
    lines.push(`Epic head was already failing ${baseline.check}: ${baseline.failures.join(", ")}`);
  }
  for (const refusal of summary.refusals) {
    lines.push(`${refusal.phase} refused its own output: ${refusal.reason}`);
  }
  for (const failure of summary.dispatchFailures) {
    lines.push(failure.refusal
      ? `${failure.refusal.gate} refused its own round in ${failure.state}: ${failure.refusal.detail}`
      : `A run died in ${failure.state} (${failure.errorClass}): ${failure.message}`);
  }
  if (summary.costUsd > 0) lines.push(`Spent on metered providers: $${summary.costUsd.toFixed(2)}`);
  return `${lines.join("\n")}\n`;
}

/** The diagnosis the summary carries, or none for a spend stop (03 section 1.5). */
export function diagnosisFor(
  reason: StoryStopReason,
  history: readonly (readonly string[])[],
): RetryDiagnosis | undefined {
  return reason === "cost_ceiling_exceeded" ? undefined : diagnoseRetryLimit(history);
}
