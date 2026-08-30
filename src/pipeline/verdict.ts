import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isWithinRoot } from "../guard/danger-rules.js";

export interface ScenarioVerdict {
  id: string;
  status: "passed" | "failed" | "inconclusive";
  url?: string;
  screenshots?: string[];
}

export interface VerdictDocument {
  scenarios: ScenarioVerdict[];
}

export interface TrajectoryEvidence {
  type: string;
  scenarioId?: string;
  status?: string;
}

export interface VerdictInput {
  verdict: VerdictDocument;
  declaredScenarioIds: string[];
  trajectory: TrajectoryEvidence[];
  commitMessages: string[];
  evidenceRoot: string;
  allowedHosts: string[];
  roundStartedAt: number;
  roundEndedAt: number;
}

export interface VerdictValidation {
  valid: boolean;
  errors: string[];
  requiresBlindReview: boolean;
  redEvidence: string[];
  greenEvidence: string[];
}

function commitEvidence(messages: readonly string[], kind: "red" | "green"): Set<string> {
  const prefix = kind === "red" ? "test" : "feat";
  const pattern = new RegExp(`^${prefix}\\((S-[A-Z0-9]+-\\d{2}-[a-z0-9]+)\\):\\s*${kind}\\b`, "i");
  const ids = new Set<string>();
  for (const message of messages) {
    const match = pattern.exec(message);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

export async function validateVerdict(input: VerdictInput): Promise<VerdictValidation> {
  const errors: string[] = [];
  const declared = new Set(input.declaredScenarioIds);
  const reported = new Set(input.verdict.scenarios.map((scenario) => scenario.id));
  for (const id of declared) if (!reported.has(id)) errors.push(`${id}: verdict is missing`);
  for (const id of reported) if (!declared.has(id)) errors.push(`${id}: verdict is not declared by the DoD`);

  const passingTrace = new Set(
    input.trajectory
      .filter((event) => event.type === "test_result" && event.status === "passed" && event.scenarioId)
      .map((event) => event.scenarioId!),
  );
  const red = commitEvidence(input.commitMessages, "red");
  const green = commitEvidence(input.commitMessages, "green");
  for (const event of input.trajectory) {
    if (event.type !== "test_result" || !event.scenarioId) continue;
    if (event.status === "failed") red.add(event.scenarioId);
    if (event.status === "passed") green.add(event.scenarioId);
  }

  const evidenceRoot = resolve(input.evidenceRoot);
  const allowedHosts = new Set(input.allowedHosts.map((host) => host.toLowerCase()));
  for (const scenario of input.verdict.scenarios) {
    if (scenario.status === "passed" && !passingTrace.has(scenario.id)) {
      errors.push(`${scenario.id}: no passing test result exists in the trajectory`);
    }
    if (scenario.url) {
      try {
        const url = new URL(scenario.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          errors.push(`${scenario.id}: URL host is not allowed (${url.protocol})`);
        } else if (!allowedHosts.has(url.hostname.toLowerCase())) {
          errors.push(`${scenario.id}: URL host is not allowed (${url.hostname})`);
        }
      } catch {
        errors.push(`${scenario.id}: URL is invalid`);
      }
    }
    for (const screenshot of scenario.screenshots ?? []) {
      const path = resolve(evidenceRoot, screenshot);
      if (!isWithinRoot(path, evidenceRoot)) {
        errors.push(`${scenario.id}: screenshot escapes the evidence root`);
        continue;
      }
      try {
        const details = await stat(path);
        if (!details.isFile()) errors.push(`${scenario.id}: screenshot is not a file (${screenshot})`);
        if (details.mtimeMs < input.roundStartedAt || details.mtimeMs > input.roundEndedAt) {
          errors.push(`${scenario.id}: screenshot mtime is outside the verification round (${screenshot})`);
        }
      } catch {
        errors.push(`${scenario.id}: screenshot does not exist (${screenshot})`);
      }
    }
  }

  const redEvidence = [...red].filter((id) => declared.has(id)).toSorted();
  const greenEvidence = [...green].filter((id) => declared.has(id)).toSorted();
  return {
    valid: errors.length === 0,
    errors,
    requiresBlindReview: input.declaredScenarioIds.some((id) => !red.has(id)),
    redEvidence,
    greenEvidence,
  };
}
