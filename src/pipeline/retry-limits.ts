import type { ConfigStore } from "../config/store.js";

export interface RetryLimits {
  maxInnerLoopRounds: number;
  maxPhaseReentries: number;
  maxContinueRetries: number;
  maxRegressionReopens: number;
}

/**
 * The four ceilings, read together so no call site invents its own default.
 * They are read per dispatch rather than per turn: a ceiling that moved while a
 * card was mid-loop would change the meaning of the rounds already spent.
 */
export async function retryLimits(config: ConfigStore): Promise<RetryLimits> {
  await config.reload();
  return {
    maxInnerLoopRounds: config.get("retry.maxInnerLoopRounds"),
    maxPhaseReentries: config.get("retry.maxPhaseReentries"),
    maxContinueRetries: config.get("retry.maxContinueRetries"),
    maxRegressionReopens: config.get("retry.maxRegressionReopens"),
  };
}

export type RetryDiagnosisSide = "requirement" | "system";

export interface RetryDiagnosis {
  /** Failed scenario count per round, oldest first. */
  curve: readonly number[];
  side: RetryDiagnosisSide;
  reason: string;
  /** Scenarios that failed in every round; the spec's own suspects. */
  persistent: readonly string[];
  /** Scenarios that passed in one round and failed again later. */
  regressed: readonly string[];
}

/**
 * Splits a spent budget into the only two answers that lead anywhere: either
 * the requirement cannot be satisfied as written, or the machinery around it is
 * unreliable. A flat curve on the same scenarios is a requirement the agent
 * cannot meet; a curve that moves up and down is an environment that will not
 * hold still. Anything else is read as system-side, because reporting a
 * requirement defect that is not there sends a human to read the wrong thing.
 */
export function diagnoseRetryLimit(history: readonly (readonly string[])[]): RetryDiagnosis {
  const curve = history.map((round) => round.length);
  const rounds = history.map((round) => new Set(round));
  const everFailed = new Set(history.flat());

  const persistent = [...everFailed]
    .filter((scenario) => rounds.every((round) => round.has(scenario)))
    .toSorted();

  const regressed = [...everFailed].filter((scenario) => {
    const passedAt = rounds.findIndex((round) => !round.has(scenario));
    return passedAt >= 0 && rounds.slice(passedAt).some((round) => round.has(scenario));
  }).toSorted();

  if (regressed.length > 0) {
    return {
      curve,
      side: "system",
      reason: `scenarios passed and then failed again without the requirement changing: ${regressed.join(", ")}`,
      persistent,
      regressed,
    };
  }
  if (persistent.length > 0 && persistent.length === everFailed.size && history.length > 1) {
    return {
      curve,
      side: "requirement",
      reason: `the same scenarios failed in every round with no progress: ${persistent.join(", ")}`,
      persistent,
      regressed,
    };
  }
  return {
    curve,
    side: "system",
    reason: history.length === 0
      ? "the budget was spent before any verification round completed"
      : "the failing set changed between rounds without settling",
    persistent,
    regressed,
  };
}

/** The human-facing report attached to the stopped card. */
export function renderRetryReport(cardId: string, limit: string, diagnosis: RetryDiagnosis): string {
  const curve = diagnosis.curve.length === 0
    ? "no verification round completed"
    : diagnosis.curve.map((count, index) => `round ${index + 1}: ${count} failing`).join(" -> ");
  const lines = [
    `${cardId} stopped: ${limit}`,
    "",
    `Convergence: ${curve}`,
    `Most likely side: ${diagnosis.side === "requirement" ? "requirement" : "system"}`,
    `Why: ${diagnosis.reason}`,
  ];
  if (diagnosis.persistent.length > 0) lines.push(`Never passed: ${diagnosis.persistent.join(", ")}`);
  if (diagnosis.regressed.length > 0) lines.push(`Passed then failed again: ${diagnosis.regressed.join(", ")}`);
  return `${lines.join("\n")}\n`;
}
