import type { BlindVerifyInput, BlindVerifyResult } from "../verify/executor.js";
import type { GitCommandPort } from "../vcs/story-delivery.js";
import type { ScenarioPool } from "./scenario-registry.js";
import type { SweepOutcome, SweepPort } from "./sweeper.js";
import type { AgentSpawnGrant } from "../runner/spawn-broker.js";
import { startAppLane, type AppLaneConfig } from "../verify/app-lane.js";

export interface BlindSweepPortOptions {
  /** A worktree per pool: the Epic pool sweeps the Epic head, the main pool main. */
  worktreeFor: (pool: ScenarioPool, branch: string) => Promise<string>;
  /** The frozen text of each scenario, by id. A sweep that only names the ids
   * asks the verifier to guess what they meant, and it judges its guess. */
  specificationFor: (scenarioIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  executor: { run(input: BlindVerifyInput): Promise<BlindVerifyResult> };
  /** The sweep's own spawn, granted per sweep so its provider capacity is held
   * only while it runs and its cost lands on the verify purpose. */
  resolveSpec: () => Promise<AgentSpawnGrant>;
  git: GitCommandPort;
  evidenceRoot: string;
  auditPath: string;
  allowedHosts: readonly string[];
  /**
   * How the swept repository starts its application. The sweep judges scenarios
   * a Story was accepted against, several of which are read off a screen; with
   * no address it invented its own service and reached a different answer from
   * the round that accepted them.
   */
  app?: Omit<AppLaneConfig, "cwd">;
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
    const grant = await this.options.resolveSpec();
    // Started per sweep and stopped whatever the sweep does; the next sweep
    // wants the same port and must not be answered by this one's tree.
    const lane = await startAppLane(
      this.options.app ? { ...this.options.app, cwd: worktreePath } : undefined,
      this.options.allowedHosts,
    );
    try {
      return await this.sweep(input, worktreePath, revision, declaredScenarioIds, specification, grant, lane);
    } finally {
      await lane.stop().catch(() => undefined);
      await grant.release().catch(() => undefined);
    }
  }

  private async sweep(
    input: { pool: ScenarioPool; branch: string; scenarioIds: readonly string[] },
    worktreePath: string,
    revision: string,
    declaredScenarioIds: string[],
    specification: string,
    grant: AgentSpawnGrant,
    lane: Awaited<ReturnType<typeof startAppLane>>,
  ): Promise<{ revision: string; outcomes: readonly SweepOutcome[]; inconclusive?: readonly string[] }> {
    const result = await this.options.executor.run({
      spec: grant.spec,
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
      allowedHosts: lane.allowedHosts,
      app: lane.app,
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
    const reasons = new Map(result.reasons.map((entry) => [entry.scenarioId, entry.reason]));
    const validationFor = (scenarioId: string) =>
      result.validationErrors.filter((error) => error.startsWith(`${scenarioId}: `));
    // What the run said about this scenario, and nothing about any other. The
    // sweep used to hand every failed scenario one shared line -- and when the
    // verifier reached a verdict without a runner failure, that line was the
    // placeholder. Every break in the repository then hashed to one signature,
    // so a card carried no reason a person could act on and, worse, recurrences
    // counted across unrelated scenarios: five failures of five different
    // things pushed each other over the threshold that opens a card.
    const outputFor = (scenarioId: string): string => {
      const own = [reasons.get(scenarioId), ...validationFor(scenarioId)].filter(Boolean).join("; ");
      if (own) return own;
      if (result.runnerFailure) return result.runnerFailure;
      // Still nothing specific: name the scenario, so two scenarios failing
      // for reasons nobody recorded stay two breaks rather than becoming one.
      return `${scenarioId} failed and the verification recorded no reason`;
    };

    return {
      revision,
      outcomes: declaredScenarioIds.map((scenarioId) => (failed.has(scenarioId)
        ? { scenarioId, outcome: "failed" as const, output: outputFor(scenarioId) }
        : { scenarioId, outcome: "passed" as const })),
    };
  }
}
