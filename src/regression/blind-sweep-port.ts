import type { BlindVerifyInput, BlindVerifyResult } from "../verify/executor.js";
import type { GitCommandPort } from "../vcs/story-delivery.js";
import type { ScenarioPool } from "./scenario-registry.js";
import type { SweepOutcome, SweepPort } from "./sweeper.js";

export interface BlindSweepPortOptions {
  /** A worktree per pool: the Epic pool sweeps the Epic head, the main pool main. */
  worktreeFor: (pool: ScenarioPool, branch: string) => Promise<string>;
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
  }> {
    const worktreePath = await this.options.worktreeFor(input.pool, input.branch);
    const revision = (await this.options.git.run(worktreePath, ["rev-parse", "HEAD"])).trim();
    const declaredScenarioIds = [...input.scenarioIds];
    const result = await this.options.executor.run({
      cardId: `regression:${input.pool}`,
      round: 1,
      // The sweep has no coding session of its own; the DB check only forbids
      // reusing one, and this id can never collide with a real session file.
      codeSessionId: `regression:${input.pool}:${revision}`,
      worktreePath,
      evidencePath: this.options.evidenceRoot,
      auditPath: this.options.auditPath,
      specification: `Re-verify these scenarios on ${input.branch}: ${declaredScenarioIds.join(", ")}`,
      declaredScenarioIds,
      allowedHosts: [...this.options.allowedHosts],
      ...(this.options.chromiumSandbox === undefined ? {} : { chromiumSandbox: this.options.chromiumSandbox }),
      commitMessages: [],
    });

    const failed = new Set(result.record.failedScenarios);
    // A verifier that never reached a verdict has not shown anything passing,
    // so an inconclusive sweep counts as a failure for every scenario in it.
    const inconclusive = result.record.verdict === "inconclusive";
    const output = [result.runnerFailure, ...result.validationErrors].filter(Boolean).join("; ")
      || "regression scenario failed without a reported reason";

    return {
      revision,
      outcomes: declaredScenarioIds.map((scenarioId) => (failed.has(scenarioId) || inconclusive
        ? { scenarioId, outcome: "failed" as const, output }
        : { scenarioId, outcome: "passed" as const })),
    };
  }
}
