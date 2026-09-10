import type { DefinitionOfDone } from "../pipeline/dod.js";
import type { UiReviewExecutor, UiReviewReference, UiReviewResult } from "../verify/ui-review.js";
import { renderUiFindings } from "../verify/ui-review.js";
import type {
  ManagedVerifyInput,
  ManagedVerifyResult,
  StoryVerifyPort,
} from "./story-worker.js";

/** Scenarios a person can look at. Anything else has no interface to accept. */
export function reviewableScenarios(dod: DefinitionOfDone): DefinitionOfDone["scenarios"] {
  return dod.scenarios.filter((scenario) =>
    scenario.layers.includes("ui") || scenario.layers.includes("e2e"));
}

function statementOf(scenario: DefinitionOfDone["scenarios"][number]): string {
  return `${scenario.given}；${scenario.when}；${scenario.then}`;
}

export interface UiReviewedVerifyPortOptions {
  /** The functional lane. Its verdict decides whether a review is worth buying. */
  functional: StoryVerifyPort;
  review: Pick<UiReviewExecutor, "run">;
  worktreePath: string;
  evidenceRoot: string;
  auditPath: string;
  allowedHosts: string[];
  chromiumSandbox?: boolean;
  storyTitle: () => Promise<{ title: string; businessGoal: string }>;
  /** Prototype images from the requirement, when it has any. */
  references?: (cardId: string) => Promise<UiReviewReference[]>;
  /**
   * Where the findings go. They are the whole reason this lane exists and they
   * never travel through the verdict, so a port that drops them loses them.
   */
  publishFindings?: (input: { cardId: string; runId: string; text: string; result: UiReviewResult }) => Promise<void>;
  /** A review that could not run says nothing about the Story; it is our problem. */
  recordFriction?: (input: { cardId: string; runId: string; kind: string; detail: string }) => Promise<void>;
}

/**
 * VERIFY with the product manager's acceptance of the interface behind it.
 *
 * The review is a second session with its own model and its own eyes: it reads
 * the screens as images and may drive the browser, and it judges the Story
 * against what a person asked for rather than against the test suite.
 *
 * Three deliberate limits:
 *
 * - It runs only after the functional lane has accepted the round. A round that
 *   is already going back to CODE gains nothing from a second opinion, and
 *   paying a brain-tier multimodal turn to confirm a known failure is waste.
 * - It runs only for scenarios declared `ui` or `e2e`. A scenario with no
 *   interface has nothing to look at.
 * - Its findings about the look of the product never reach the verdict; only a
 *   missing or wrong function does. See the reasoning in `ui-review.ts`.
 */
export class UiReviewedVerifyPort implements StoryVerifyPort {
  constructor(private readonly options: UiReviewedVerifyPortOptions) {}

  async run(input: ManagedVerifyInput): Promise<ManagedVerifyResult> {
    const functional = await this.options.functional.run(input);
    const scenarios = reviewableScenarios(input.definitionOfDone);
    if (functional.verdict !== "accepted" || scenarios.length === 0) return functional;

    const reviewable = new Set(scenarios.map((scenario) => scenario.id));
    const story = await this.options.storyTitle();
    const result = await this.options.review.run({
      cardId: input.context.cardId,
      round: input.round,
      storyTitle: story.title,
      businessGoal: story.businessGoal,
      scenarios: scenarios.map((scenario) => ({ id: scenario.id, statement: statementOf(scenario) })),
      screenshots: (functional.screenshots ?? []).filter((shot) => reviewable.has(shot.scenarioId)),
      ...(this.options.references ? { references: await this.options.references(input.context.cardId) } : {}),
      worktreePath: this.options.worktreePath,
      evidencePath: functional.evidenceDir ?? this.options.evidenceRoot,
      auditPath: this.options.auditPath,
      allowedHosts: this.options.allowedHosts,
      ...(this.options.chromiumSandbox === undefined ? {} : { chromiumSandbox: this.options.chromiumSandbox }),
    });

    const findingsText = renderUiFindings(result.findings);
    if (this.options.publishFindings) {
      await this.options.publishFindings({
        cardId: input.context.cardId,
        runId: input.runId,
        text: findingsText,
        result,
      });
    }
    // The functional fields stay at the top level: the Notion projection reads
    // this artifact for the round summary, and nesting them would silently
    // empty the line a person reads after a rejected round.
    const artifact = JSON.stringify({
      ...(JSON.parse(functional.artifact) as Record<string, unknown>),
      uiReview: {
        verdict: result.verdict,
        acceptance: result.acceptance,
        findings: result.findings,
        findingsText,
        validationErrors: result.validationErrors,
        runnerFailure: result.runnerFailure,
        images: result.images,
        sessionId: result.reviewSessionId,
      },
    });

    if (result.verdict === "rejected") {
      return {
        ...functional,
        verdict: "rejected",
        failedScenarios: result.failedScenarios,
        // A function the reviewer could not find on the screen is a failure in
        // the code, so it counts against convergence like any other.
        codeFailedScenarios: result.failedScenarios,
        artifact,
      };
    }
    if (result.verdict === "inconclusive" && this.options.recordFriction) {
      // A review that never happened must not park the card: 03 section 8.6
      // keeps an environment failure out of the failed set. It is still our
      // defect, so it is recorded as friction rather than silently dropped.
      await this.options.recordFriction({
        cardId: input.context.cardId,
        runId: input.runId,
        kind: "ui_review_inconclusive",
        detail: result.runnerFailure ?? result.validationErrors.join("; ") ?? "the reviewer reached no verdict",
      });
    }
    return { ...functional, artifact };
  }
}
