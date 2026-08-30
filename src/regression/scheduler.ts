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
  /** Scenarios a merge just made worth re-running immediately. */
  triggered?: readonly string[];
  policy: RegressionSchedulePolicy;
}

function stale(
  scenarios: readonly RegisteredScenario[],
  now: number,
  intervalMs: number,
  batchSize: number,
): string[] {
  return scenarios
    // A scenario nobody has verified is as stale as it gets.
    .filter((scenario) => scenario.lastVerifiedAt === null || now - scenario.lastVerifiedAt >= intervalMs)
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
  const triggered = input.triggered ?? [];
  if (triggered.length > 0) {
    return { pool: "epic", scenarioIds: [...triggered].toSorted(), reason: "event" };
  }
  if (input.foregroundBusy) return null;

  const epic = stale(input.epicScenarios, input.now, input.policy.epicPoolIntervalMs, input.policy.batchSize);
  if (epic.length > 0) return { pool: "epic", scenarioIds: epic, reason: "idle" };

  const main = stale(input.mainScenarios, input.now, input.policy.mainPoolIntervalMs, input.policy.batchSize);
  return main.length > 0 ? { pool: "main", scenarioIds: main, reason: "idle" } : null;
}
