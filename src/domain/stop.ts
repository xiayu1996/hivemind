/**
 * The only three reasons the loop stops working on a requirement on its own:
 * no progress, budget spent, or a question only a person can answer. Every
 * other check is a signal that is recorded, never a stop.
 */

export type StopReason = "no_progress" | "budget" | "question";

export interface Limits {
  /** Builder attempts per plan item before the planner is asked to rework it. */
  maxItemAttempts: number;
  /** Planner reworks per item before a person is asked. */
  maxReplans: number;
  /** Author sessions per step whose output still fails validation before a person is asked. */
  maxAuthorSessions: number;
  /** Consecutive evaluator runs that could not judge before a person is asked about the environment. */
  maxInconclusive: number;
  /** Findings handed back into one session before the attempt counts as failed. */
  maxHandbacks: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxItemAttempts: 3,
  maxReplans: 1,
  maxAuthorSessions: 2,
  maxInconclusive: 2,
  maxHandbacks: 3,
};

export type AfterFailure = "retry" | "replan" | "stop";

/**
 * What to do once an item attempt failed. `attempts` already counts the failed
 * one. Replanning resets the attempt count, so each reworked item gets the
 * same number of tries as the original.
 */
export function afterItemFailure(attempts: number, replans: number, limits: Limits): AfterFailure {
  if (attempts < limits.maxItemAttempts) return "retry";
  if (replans < limits.maxReplans) return "replan";
  return "stop";
}

/**
 * Spend counts every provider at its API-equivalent price, subscriptions
 * included: a flat-rate plan is still money, and a ceiling that ignores it
 * guards nothing on the providers most work runs on.
 */
export function budgetExceeded(spentUsd: number, budgetUsd: number): boolean {
  return budgetUsd > 0 && spentUsd >= budgetUsd;
}
