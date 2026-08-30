import type { ScenarioPool } from "./scenario-registry.js";
import type { ScenarioRegistry } from "./scenario-registry.js";
import type { RegressionStore } from "./store.js";
import type { RegressionPolicy } from "./verdict.js";

export interface SweepOutcome {
  scenarioId: string;
  outcome: "passed" | "failed";
  /** Failure text, used to name the break. */
  output?: string;
}

export interface SweepPort {
  /** Runs the scenarios against the given branch and reports one outcome each. */
  run(input: { pool: ScenarioPool; branch: string; scenarioIds: readonly string[] }): Promise<{
    revision: string;
    outcomes: readonly SweepOutcome[];
  }>;
}

export interface SweepResult {
  pool: ScenarioPool;
  revision: string;
  verified: readonly string[];
  failed: readonly string[];
  raised: ReadonlyArray<{ scenarioId: string; signature: string }>;
}

/**
 * Runs one planned sweep and turns its outcomes into durable judgements.
 *
 * Only a passing scenario updates "last verified": a failing one has not been
 * shown to hold, and letting a failure count as verification would push it to
 * the back of the queue exactly when it deserves to stay at the front.
 */
export class RegressionSweeper {
  constructor(
    private readonly registry: ScenarioRegistry,
    private readonly store: RegressionStore,
    private readonly port: SweepPort,
  ) {}

  async sweep(
    input: { pool: ScenarioPool; branch: string; scenarioIds: readonly string[] },
    policy: RegressionPolicy,
  ): Promise<SweepResult> {
    if (input.scenarioIds.length === 0) {
      return { pool: input.pool, revision: "", verified: [], failed: [], raised: [] };
    }
    const { revision, outcomes } = await this.port.run(input);
    const verified: string[] = [];
    const failed: string[] = [];
    const raised: Array<{ scenarioId: string; signature: string }> = [];

    for (const outcome of outcomes) {
      const result = await this.store.record({
        scenarioId: outcome.scenarioId,
        pool: input.pool,
        revision,
        outcome: outcome.outcome,
        ...(outcome.output === undefined ? {} : { output: outcome.output }),
      }, policy);
      if (outcome.outcome === "passed") verified.push(outcome.scenarioId);
      else failed.push(outcome.scenarioId);
      if (result.cardRaised && result.judgement.kind === "raise") {
        raised.push({ scenarioId: outcome.scenarioId, signature: result.judgement.signature });
      }
    }
    await this.registry.markVerified(verified);
    return { pool: input.pool, revision, verified, failed, raised };
  }
}
