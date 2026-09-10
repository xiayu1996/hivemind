import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { splitScenarioFailures } from "../pipeline/failure-classification.js";
import type { BlindVerifyExecutor, BlindVerifyResult } from "../verify/executor.js";
import type { PhaseTelemetryInput } from "./pi-phase-port.js";
import type {
  ManagedVerifyInput,
  ManagedVerifyResult,
  StoryVerifyPort,
} from "./story-worker.js";

export interface BlindVerifyStoryPortOptions {
  executor: Pick<BlindVerifyExecutor, "run">;
  worktreePath: string;
  evidenceRoot: string;
  auditPath: string;
  allowedHosts: string[];
  chromiumSandbox?: boolean;
  commitMessages: () => Promise<string[]>;
  recordTelemetry?: (input: PhaseTelemetryInput) => Promise<void>;
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
    const result = await this.options.executor.run({
      cardId: input.context.cardId,
      round: input.round,
      codeSessionId: input.codeSessionId,
      worktreePath: this.options.worktreePath,
      evidencePath,
      auditPath: this.options.auditPath,
      specification: JSON.stringify(input.definitionOfDone),
      declaredScenarioIds: input.definitionOfDone.scenarios.map((scenario) => scenario.id),
      allowedHosts: this.options.allowedHosts,
      ...(this.options.chromiumSandbox === undefined ? {} : { chromiumSandbox: this.options.chromiumSandbox }),
      commitMessages: await this.options.commitMessages(),
    });
    if (this.options.recordTelemetry) {
      const capturePath = join(evidencePath, "provider-requests.jsonl");
      const providerPayloads = await (this.options.readProviderPayloads ?? readProviderPayloads)(capturePath);
      if (providerPayloads.length === 0) throw new Error("VERIFY provider request was not captured");
      await this.options.recordTelemetry({
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
      });
    }
    // The convergence criterion runs on the code-level failures alone; a
    // scenario the environment lost is reported but not compared (03 8.6).
    const split = splitScenarioFailures(result.record.failedScenarios, [
      ...result.reasons,
      ...result.validationErrors.map((error) => ({
        scenarioId: error.slice(0, error.indexOf(": ")),
        reason: error,
      })),
    ]);
    return {
      sessionId: result.record.verifySessionId,
      verdict: result.record.verdict,
      failedScenarios: result.record.failedScenarios,
      codeFailedScenarios: split.code,
      evidenceDir: result.record.evidenceDir,
      screenshots: result.screenshots,
      artifact: verificationArtifact(result),
    };
  }
}

async function readProviderPayloads(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
}
