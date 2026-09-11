import type { BlindVerifyInput, BlindVerifyResult } from "../verify/executor.js";
import type { GitCommandPort } from "../vcs/story-delivery.js";
import type { ScenarioPool } from "./scenario-registry.js";
import type { SweepOutcome, SweepPort } from "./sweeper.js";

export interface BlindSweepPortOptions {
  /** A worktree per pool: the Epic pool sweeps the Epic head, the main pool main. */
  worktreeFor: (pool: ScenarioPool, branch: string) => Promise<string>;
  /** The frozen text of each scenario, by id. A sweep that only names the ids
   * asks the verifier to guess what they meant, and it judges its guess. */
  specificationFor: (scenarioIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  executor: { run(input: BlindVerifyInput): Promise<BlindVerifyResult> };
  git: GitCommandPort;
  evidenceRoot: string;
  auditPath: string;
  allowedHosts: readonly string[];
  chromiumSandbox?: boolean;
}

/**
 * Sweeps through the same blind verifier a Story uses, so a regression run
 * chooses its commands the way every other verification does and its evidence
 * passes the same code-side checks.
 */
export class BlindSweepPort implements SweepPort {
  constructor(private readonly options: BlindSweepPortOptions) {}

  async run(input: { pool: ScenarioPool; branch: string; scenarioIds: readonly string[] }): Promise<{
    revision: string;
    outcomes: readonly SweepOutcome[];
    inconclusive?: readonly string[];
  }> {
    const worktreePath = await this.options.worktreeFor(input.pool, input.branch);
    const revision = (await this.options.git.run(worktreePath, ["rev-parse", "HEAD"])).trim();
    const declaredScenarioIds = [...input.scenarioIds];
    const specifications = await this.options.specificationFor(declaredScenarioIds);
    const missing = declaredScenarioIds.filter((scenarioId) => !specifications.has(scenarioId));
    if (missing.length > 0) {
      throw new Error(`regression sweep has no frozen text for ${missing.join(", ")}`);
    }
    const specification = [
      `Re-verify these scenarios on ${input.branch}. Each is the frozen text its Story was accepted against; judge it as written.`,
      ...declaredScenarioIds.map((scenarioId) => `${scenarioId}: ${specifications.get(scenarioId)!}`),
    ].join("\n");
    const result = await this.options.executor.run({
      cardId: `regression:${input.pool}`,
      round: 1,
      // The sweep has no coding session of its own; the DB check only forbids
      // reusing one, and this id can never collide with a real session file.
      codeSessionId: `regression:${input.pool}:${revision}`,
      worktreePath,
      evidencePath: this.options.evidenceRoot,
      auditPath: this.options.auditPath,
      specification,
      declaredScenarioIds,
      allowedHosts: [...this.options.allowedHosts],
      ...(this.options.chromiumSandbox === undefined ? {} : { chromiumSandbox: this.options.chromiumSandbox }),
      commitMessages: [],
    });

    // A verifier that never reached a verdict has shown nothing either way.
    // Calling that a failure raised regression cards against the code for a
    // dev server that never came up, and attribution then went looking for the
    // commit that broke it.
    if (result.record.verdict === "inconclusive") {
      return { revision, outcomes: [], inconclusive: declaredScenarioIds };
    }
    const failed = new Set(result.record.failedScenarios);
    const output = [result.runnerFailure, ...result.validationErrors].filter(Boolean).join("; ")
      || "regression scenario failed without a reported reason";

    return {
      revision,
      outcomes: declaredScenarioIds.map((scenarioId) => (failed.has(scenarioId)
        ? { scenarioId, outcome: "failed" as const, output }
        : { scenarioId, outcome: "passed" as const })),
    };
  }
}
