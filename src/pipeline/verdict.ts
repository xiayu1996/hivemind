import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isWithinRoot } from "../guard/danger-rules.js";
import { SCREEN_EVIDENCE_MISSING } from "./failure-classification.js";

export interface ScenarioVerdict {
  id: string;
  status: "passed" | "failed" | "inconclusive";
  /**
   * One sentence in Chinese, in the words of whoever ordered the card: what
   * was seen on which screen. It is the only thing a person reading the board
   * decides from when a round is rejected, so the technical evidence behind it
   * belongs in `detail`, which the page keeps folded.
   */
  reason?: string;
  /** The failing test, the command, the line: written for whoever debugs it. */
  detail?: string;
  url?: string;
  screenshots?: string[];
  /**
   * The accessibility snapshots this scenario reached, as `page-*.yml` names
   * under the evidence root. Declared beside the screenshots rather than paired
   * with them by name: the two are separate captures and their timestamps do
   * not match, so pairing would be a guess. The structural layer reads these.
   */
  snapshots?: string[];
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
  /**
   * Scenarios with a layer only a browser settles. Each needs a page the
   * verifier reached and a screenshot no other scenario claims: one shot named
   * under four scenarios is one look, not four (03 section 9).
   */
  screenScenarioIds?: readonly string[];
}

export interface VerdictValidation {
  valid: boolean;
  errors: string[];
  requiresBlindReview: boolean;
  redEvidence: string[];
  greenEvidence: string[];
  /** Screen scenarios the verifier judged without leaving evidence of its own. */
  unproven: string[];
  /**
   * The subset of `errors` saying the verifier declared evidence it did not
   * leave, so the round has nothing to read rather than something wrong to
   * report.
   *
   * Carried rather than recognised again from the wording: this is the one
   * place that knows a file was looked for and was not there, and a caller
   * that re-derives it from the text gets a different answer every time the
   * text is reworded -- `snapshot does not exist` went unrecognised for as
   * long as the pattern for it said `screenshot`.
   */
  missingEvidence: string[];
}

/**
 * The two red/green channels of section 2.3, read as one set each: the commit
 * messages CODE is required to write per scenario, and the test events its
 * session emitted. Shared with the deterministic CODE exit so the convention
 * has exactly one reader.
 */
export function redGreenFromCommits(
  commitMessages: readonly string[],
  trajectory: readonly TrajectoryEvidence[],
): { red: Set<string>; green: Set<string> } {
  const red = commitEvidence(commitMessages, "red");
  const green = commitEvidence(commitMessages, "green");
  for (const event of trajectory) {
    if (event.type !== "test_result" || !event.scenarioId) continue;
    if (event.status === "failed") red.add(event.scenarioId);
    if (event.status === "passed") green.add(event.scenarioId);
  }
  return { red, green };
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
  const missingEvidence: string[] = [];
  /** An error about evidence that was declared and is not there to read. */
  const refuseMissing = (message: string): void => {
    errors.push(message);
    missingEvidence.push(message);
  };
  const declared = new Set(input.declaredScenarioIds);
  const reported = new Set(input.verdict.scenarios.map((scenario) => scenario.id));
  for (const id of declared) if (!reported.has(id)) errors.push(`${id}: verdict is missing`);
  for (const id of reported) if (!declared.has(id)) errors.push(`${id}: verdict is not declared by the DoD`);

  const passingTrace = new Set(
    input.trajectory
      .filter((event) => event.type === "test_result" && event.status === "passed" && event.scenarioId)
      .map((event) => event.scenarioId!),
  );
  const { red, green } = redGreenFromCommits(input.commitMessages, input.trajectory);

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
    // Both kinds of evidence answer the same three questions, so they are
    // checked by one loop: a file outside the root, from another round, or
    // absent is worth nothing whether it is an image or a tree.
    for (const [kind, files] of [
      ["screenshot", scenario.screenshots ?? []],
      ["snapshot", scenario.snapshots ?? []],
    ] as const) {
      for (const file of files) {
        const path = resolve(evidenceRoot, file);
        if (!isWithinRoot(path, evidenceRoot)) {
          errors.push(`${scenario.id}: ${kind} escapes the evidence root`);
          continue;
        }
        try {
          const details = await stat(path);
          if (!details.isFile()) refuseMissing(`${scenario.id}: ${kind} is not a file (${file})`);
          if (details.mtimeMs < input.roundStartedAt || details.mtimeMs > input.roundEndedAt) {
            errors.push(`${scenario.id}: ${kind} mtime is outside the verification round (${file})`);
          }
        } catch {
          refuseMissing(`${scenario.id}: ${kind} does not exist (${file})`);
        }
      }
    }
  }

  const unproven: string[] = [];
  const screen = new Set(input.screenScenarioIds ?? []);
  const claimedBy = new Map<string, Set<string>>();
  for (const scenario of input.verdict.scenarios) {
    for (const shot of scenario.screenshots ?? []) {
      claimedBy.set(shot, new Set([...(claimedBy.get(shot) ?? []), scenario.id]));
    }
  }
  for (const scenario of input.verdict.scenarios) {
    if (!screen.has(scenario.id) || scenario.status === "inconclusive") continue;
    const own = (scenario.screenshots ?? []).filter((shot) => claimedBy.get(shot)?.size === 1);
    const missing = [
      ...(scenario.url ? [] : ["no page was reported"]),
      ...(own.length > 0 ? [] : ["no screenshot belongs to it alone"]),
    ];
    if (missing.length === 0) continue;
    unproven.push(scenario.id);
    refuseMissing(`${scenario.id}: ${SCREEN_EVIDENCE_MISSING} (${missing.join("; ")})`);
  }

  const redEvidence = [...red].filter((id) => declared.has(id)).toSorted();
  const greenEvidence = [...green].filter((id) => declared.has(id)).toSorted();
  return {
    valid: errors.length === 0,
    errors,
    requiresBlindReview: input.declaredScenarioIds.some((id) => !red.has(id)),
    redEvidence,
    greenEvidence,
    unproven: unproven.toSorted(),
    missingEvidence,
  };
}
