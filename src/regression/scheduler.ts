import type { RegisteredScenario, ScenarioPool } from "./scenario-registry.js";

export interface RegressionSchedulePolicy {
  epicPoolIntervalMs: number;
  mainPoolIntervalMs: number;
  batchSize: number;
}

export interface RegressionSweep {
  pool: ScenarioPool;
  scenarioIds: readonly string[];
  reason: "event" | "idle";
}

export interface RegressionScheduleInput {
  now: number;
  /** A Story is running on this host. Idle polling waits; an event does not. */
  foregroundBusy: boolean;
  epicScenarios: readonly RegisteredScenario[];
  mainScenarios: readonly RegisteredScenario[];
  /** Scenarios the foreground is waiting on: an Epic ready to open its review
   * request cannot do so until these pass. Swept before anything else and
   * without waiting for the host to go idle. */
  triggered?: readonly string[];
  policy: RegressionSchedulePolicy;
}

function due(
  scenarios: readonly RegisteredScenario[],
  now: number,
  intervalMs: number,
): RegisteredScenario[] {
  // A scenario nobody has verified is as stale as it gets.
  return scenarios.filter((scenario) =>
    scenario.lastVerifiedAt === null || now - scenario.lastVerifiedAt >= intervalMs);
}

/**
 * One Epic per batch. Every scenario in a sweep runs in one worktree at one
 * revision, so a batch drawn across two Epics would judge the second Epic's
 * scenarios against the first Epic's code: they fail for being absent, and the
 * runs are recorded against a revision their own Epic never had, so the gate
 * that waits for them is never satisfied. The batch follows whichever Epic owns
 * the stalest scenario.
 */
function firstEpicBatch(scenarios: readonly RegisteredScenario[], batchSize: number): string[] {
  const leader = scenarios[0];
  if (!leader) return [];
  return scenarios
    .filter((scenario) => scenario.epicId === leader.epicId)
    .slice(0, batchSize)
    .map((scenario) => scenario.scenarioId);
}

/**
 * Picks the next regression sweep. Two pools with different clocks: the Epic
 * pool guards work that is still landing and runs often; the main pool guards
 * everything ever delivered and runs slowly. Idle polling gives way to a Story
 * on this host, because a regression sweep that starves the foreground turns a
 * safety net into a queue.
 */
export function planRegressionSweep(input: RegressionScheduleInput): RegressionSweep | null {
  // Work the foreground is waiting on, not background hygiene. An Epic whose
  // Stories have all landed cannot open its review request until its scenarios
  // have passed, so this sweep is the thing standing between it and delivery -
  // it does not queue behind a Story running for some other Epic, and it does
  // not queue behind another Epic's never-verified scenarios sorting first.
  const triggeredIds = new Set(input.triggered ?? []);
  if (triggeredIds.size > 0) {
    const triggered = firstEpicBatch(
      input.epicScenarios.filter((scenario) => triggeredIds.has(scenario.scenarioId)),
      input.policy.batchSize,
    );
    if (triggered.length > 0) return { pool: "epic", scenarioIds: triggered, reason: "event" };
  }
  if (input.foregroundBusy) return null;

  const epic = firstEpicBatch(
    due(input.epicScenarios, input.now, input.policy.epicPoolIntervalMs),
    input.policy.batchSize,
  );
  if (epic.length > 0) return { pool: "epic", scenarioIds: epic, reason: "idle" };

  // The main pool is one tree at one revision by definition, so it needs no
  // such grouping.
  const main = due(input.mainScenarios, input.now, input.policy.mainPoolIntervalMs)
    .slice(0, input.policy.batchSize)
    .map((scenario) => scenario.scenarioId);
  return main.length > 0 ? { pool: "main", scenarioIds: main, reason: "idle" } : null;
}
