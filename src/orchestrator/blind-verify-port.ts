import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { screenScenarios } from "../pipeline/dod.js";
import { splitScenarioFailures } from "../pipeline/failure-classification.js";
import type { BlindVerifyExecutor, BlindVerifyResult } from "../verify/executor.js";
import type { PhaseCostRow, PhaseTelemetryInput } from "./pi-phase-port.js";
import type { ResolvedAgentSpec } from "../runner/agent-spec.js";
import type { AgentSpawnGrant } from "../runner/spawn-broker.js";
import { emitSafely } from "../observability/emit-safely.js";
import type {
  ManagedVerifyInput,
  ManagedVerifyResult,
  StoryVerifyPort,
} from "./story-worker.js";

export interface BlindVerifyStoryPortOptions {
  executor: Pick<BlindVerifyExecutor, "run">;
  /**
   * The verifier's own spawn, granted per round. Its cost is attributed to the
   * verify purpose rather than to whatever the builder happened to run on, and
   * the provider capacity it holds is released when the round ends -- the
   * verify lane spawns as often as the inner loop turns.
   */
  resolveSpec: () => Promise<AgentSpawnGrant>;
  worktreePath: string;
  evidenceRoot: string;
  auditPath: string;
  allowedHosts: string[];
  chromiumSandbox?: boolean;
  commitMessages: () => Promise<string[]>;
  /** Execution state; see the phase port. */
  recordCost?: (input: PhaseTelemetryInput) => Promise<PhaseCostRow | void>;
  /** Ring 0: synchronous, no I/O, never throws. */
  emit?: (type: string, data: unknown) => void;
  readProviderPayloads?: (path: string) => Promise<unknown[]>;
}

function verificationArtifact(result: BlindVerifyResult): string {
  return JSON.stringify({
    verdict: result.record.verdict,
    failedScenarios: result.record.failedScenarios,
    reasons: result.reasons,
    validationErrors: result.validationErrors,
    treeChanged: result.treeChanged,
    evidenceDir: result.record.evidenceDir,
    screenshots: result.screenshots,
  });
}

/** Adapts the blind verifier into the single-Story worker without exposing the CODE transcript. */
export class BlindVerifyStoryPort implements StoryVerifyPort {
  constructor(private readonly options: BlindVerifyStoryPortOptions) {}

  async run(input: ManagedVerifyInput): Promise<ManagedVerifyResult> {
    const evidencePath = join(this.options.evidenceRoot, input.runId);
    await mkdir(evidencePath, { recursive: true });
    const grant = await this.options.resolveSpec();
    try {
      return await this.verify(input, evidencePath, grant.spec);
    } finally {
      await grant.release().catch(() => undefined);
    }
  }

  private async verify(
    input: ManagedVerifyInput,
    evidencePath: string,
    spec: ResolvedAgentSpec,
  ): Promise<ManagedVerifyResult> {
    const result = await this.options.executor.run({
      spec,
      cardId: input.context.cardId,
      round: input.round,
      codeSessionId: input.codeSessionId,
      worktreePath: this.options.worktreePath,
      evidencePath,
      auditPath: this.options.auditPath,
      specification: JSON.stringify(input.definitionOfDone),
      declaredScenarioIds: input.definitionOfDone.scenarios.map((scenario) => scenario.id),
      screenScenarioIds: screenScenarios(input.definitionOfDone).map((scenario) => scenario.id),
      // From the frozen DoD, the same place the declared ids come from: the
      // structural layer is only worth anything if what it compares against
      // was written before the round it is judging.
      visibleRequirements: new Map(
        input.definitionOfDone.scenarios
          .filter((scenario) => scenario.visible !== undefined)
          .map((scenario) => [scenario.id, scenario.visible!]),
      ),
      allowedHosts: this.options.allowedHosts,
      ...(this.options.chromiumSandbox === undefined ? {} : { chromiumSandbox: this.options.chromiumSandbox }),
      commitMessages: await this.options.commitMessages(),
    });
    if (this.options.recordCost ?? this.options.emit) {
      const capturePath = join(evidencePath, "provider-requests.jsonl");
      const providerPayloads = await (this.options.readProviderPayloads ?? readProviderPayloads)(capturePath);
      if (providerPayloads.length === 0) throw new Error("VERIFY provider request was not captured");
      const telemetry: PhaseTelemetryInput = {
        runId: input.runId,
        cardId: input.context.cardId,
        phase: "VERIFY",
        messages: result.messages,
        result: {
          settled: result.runnerFailure === null,
          failure: result.runnerFailure === null
            ? null
            : { errorMessage: result.runnerFailure, willRetry: false },
          events: result.events,
          usage: result.usage,
        },
        providerPayloads,
        spec,
      };
      const cost = await this.options.recordCost?.(telemetry);
      emitSafely(this.options.emit, { ...telemetry, ...(cost ? { cost: cost.data } : {}) });
    }
    // The convergence criterion runs on the code-level failures alone; a
    // scenario the environment lost is reported but not compared (03 8.6).
    const split = splitScenarioFailures(result.record.failedScenarios, [
      ...result.reasons,
      ...result.validationErrors.map((error) => ({
        scenarioId: error.slice(0, error.indexOf(": ")),
        reason: error,
      })),
      // The executor already judged these reasons for its own verdict. Reusing
      // its answer rather than asking again keeps the verdict and the failed
      // set describing the same round.
    ], result.environmentalReasons);
    return {
      sessionId: result.record.verifySessionId,
      verdict: result.record.verdict,
      failedScenarios: result.record.failedScenarios,
      codeFailedScenarios: split.code,
      evidenceDir: result.record.evidenceDir,
      screenshots: result.screenshots,
      pages: result.pages,
      artifact: verificationArtifact(result),
    };
  }
}

async function readProviderPayloads(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
}
