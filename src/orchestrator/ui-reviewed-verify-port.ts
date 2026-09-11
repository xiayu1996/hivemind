import { refusableStatements, screenScenarios, seedOf, type DefinitionOfDone, type DoDScenario } from "../pipeline/dod.js";
import { splitScenarioFailures } from "../pipeline/failure-classification.js";
import { AppUnderReview } from "../verify/app-under-review.js";
import type { UiReviewExecutor, UiReviewReference, UiReviewResult, UiReviewScenario } from "../verify/ui-review.js";
import { renderDodAmendments, renderUiFindings } from "../verify/ui-review.js";
import type {
  ManagedVerifyInput,
  ManagedVerifyResult,
  StoryVerifyPort,
} from "./story-worker.js";

/** Scenarios a person can look at. Anything else has no interface to accept. */
export function reviewableScenarios(dod: DefinitionOfDone): DefinitionOfDone["scenarios"] {
  return screenScenarios(dod);
}

function statementOf(scenario: DoDScenario): string {
  const source = scenario.source ? `；数据来源：${scenario.source}` : "";
  return `${scenario.given}；${scenario.when}；${scenario.then}${source}`;
}

/** How the repository under review is brought up and filled with data (config `verify.app*` / `verify.seedCommand`). */
export interface UiReviewAppOptions {
  /** argv run in the worktree; empty means there is no application to start. */
  startCommand: string[];
  /** Polled until 2xx/3xx, then handed to the reviewer; empty means do not wait. */
  readyUrl: string;
  readyTimeoutMs: number;
  /** argv run once per reviewed scenario that declares a seed; empty means no seeding. */
  seedCommand: string[];
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
  app?: UiReviewAppOptions;
  /** Builds the process handle for the application; tests substitute a fake. */
  appUnderReview?: () => Pick<AppUnderReview, "start" | "stop" | "seed">;
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

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    // Not a URL the reviewer's browser could open; the allowlist stays as it was.
    return null;
  }
}

function inconclusiveOf(result: UiReviewResult, fallback: readonly string[], reason: string | null): Array<{ id: string; reason: string }> {
  const listed = result.acceptance
    .filter((entry) => entry.status === "inconclusive")
    .map((entry) => ({ id: entry.id, reason: entry.reason ?? "no reason recorded" }));
  if (listed.length > 0 || reason === null) return listed;
  // The review never reached a per-scenario verdict, so every scenario it was
  // asked about is inconclusive for the same reason.
  return fallback.map((id) => ({ id, reason }));
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
 *
 * When the repository says how to start its application, the reviewer gets a
 * running page with the scenarios' sample data in it rather than only the
 * functional lane's screenshots. An application that cannot be brought up is
 * the box's failure: the round stays accepted on the functional lane and every
 * reviewable scenario is recorded inconclusive with the reason.
 */
export class UiReviewedVerifyPort implements StoryVerifyPort {
  constructor(private readonly options: UiReviewedVerifyPortOptions) {}

  async run(input: ManagedVerifyInput): Promise<ManagedVerifyResult> {
    const functional = await this.options.functional.run(input);
    const scenarios = reviewableScenarios(input.definitionOfDone);
    if (functional.verdict !== "accepted" || scenarios.length === 0) return functional;

    const reviewable = new Set(scenarios.map((scenario) => scenario.id));
    const reviewableIds = scenarios.map((scenario) => scenario.id);
    const story = await this.options.storyTitle();
    const app = this.options.app;
    const handle = app && app.startCommand.length > 0
      ? (this.options.appUnderReview ?? (() => new AppUnderReview()))()
      : null;

    let result: UiReviewResult;
    let appFailure: string | null = null;
    const seedFailures: string[] = [];
    try {
      let appUrl: string | undefined;
      if (handle && app) {
        const started = await handle.start({
          cwd: this.options.worktreePath,
          command: app.startCommand,
          readyUrl: app.readyUrl,
          timeoutMs: app.readyTimeoutMs,
        });
        if (started.started) {
          appUrl = started.url || undefined;
          if (app.seedCommand.length > 0) {
            for (const scenario of scenarios) {
              const seed = seedOf(scenario);
              if (!seed) continue;
              const seeded = await handle.seed({
                cwd: this.options.worktreePath,
                command: app.seedCommand,
                scenarioId: scenario.id,
                seed,
              });
              if (!seeded.ok) seedFailures.push(`${scenario.id}: ${seeded.output}`);
            }
          }
        } else {
          appFailure = started.reason;
        }
      }

      if (appFailure !== null) {
        result = unavailableReview(appFailure);
      } else {
        const appHost = appUrl ? hostOf(appUrl) : null;
        const allowedHosts = appHost && !this.options.allowedHosts.includes(appHost)
          ? [...this.options.allowedHosts, appHost]
          : this.options.allowedHosts;
        result = await this.options.review.run({
          cardId: input.context.cardId,
          round: input.round,
          storyTitle: story.title,
          businessGoal: story.businessGoal,
          scenarios: scenarios.map((scenario) => {
            const item: UiReviewScenario = {
              id: scenario.id,
              statement: statementOf(scenario),
              refusable: refusableStatements(scenario),
            };
            const seed = seedOf(scenario);
            if (seed !== undefined) item.seed = seed;
            return item;
          }),
          outOfScope: input.definitionOfDone.out_of_scope,
          reliesOn: input.definitionOfDone.relies_on,
          screenshots: (functional.screenshots ?? []).filter((shot) => reviewable.has(shot.scenarioId)),
          ...(this.options.references ? { references: await this.options.references(input.context.cardId) } : {}),
          ...(appUrl ? { appUrl } : {}),
          worktreePath: this.options.worktreePath,
          evidencePath: functional.evidenceDir ?? this.options.evidenceRoot,
          auditPath: this.options.auditPath,
          allowedHosts,
          ...(this.options.chromiumSandbox === undefined ? {} : { chromiumSandbox: this.options.chromiumSandbox }),
        });
      }
    } finally {
      if (handle) await handle.stop().catch(() => undefined);
    }

    if (appFailure !== null && this.options.recordFriction) {
      await this.options.recordFriction({
        cardId: input.context.cardId,
        runId: input.runId,
        kind: "ui_review_app_unavailable",
        detail: appFailure,
      });
    }
    if (seedFailures.length > 0 && this.options.recordFriction) {
      await this.options.recordFriction({
        cardId: input.context.cardId,
        runId: input.runId,
        kind: "ui_review_seed_failed",
        detail: seedFailures.join("; "),
      });
    }

    const amendmentsText = renderDodAmendments(result.amendments);
    const findingsText = [renderUiFindings(result.findings), amendmentsText].filter(Boolean).join("\n\n");
    if (this.options.publishFindings) {
      await this.options.publishFindings({
        cardId: input.context.cardId,
        runId: input.runId,
        text: findingsText,
        result,
      });
    }
    const inconclusive = inconclusiveOf(
      result,
      reviewableIds,
      appFailure ?? result.runnerFailure ?? (result.validationErrors.length > 0 ? result.validationErrors.join("; ") : null),
    );
    // The functional fields stay at the top level: the Notion projection reads
    // this artifact for the round summary, and nesting them would silently
    // empty the line a person reads after a rejected round.
    const artifact = JSON.stringify({
      ...(JSON.parse(functional.artifact) as Record<string, unknown>),
      uiReview: {
        verdict: result.verdict,
        acceptance: result.acceptance,
        findings: result.findings,
        amendments: result.amendments,
        findingsText,
        validationErrors: result.validationErrors,
        runnerFailure: result.runnerFailure,
        inconclusive: inconclusive.map((entry) => entry.id),
        inconclusiveReasons: inconclusive,
        ...(appFailure === null ? {} : { appFailure }),
        ...(seedFailures.length === 0 ? {} : { seedFailures }),
        images: result.images,
        sessionId: result.reviewSessionId,
      },
    });

    // What the reviewer could not see because the box misbehaved is not a
    // failure of the code, and the reviewer stands its own harness up: a 500 it
    // meets may well be its own. The same split the functional lane applies.
    const split = splitScenarioFailures(
      result.failedScenarios,
      result.acceptance
        .filter((entry) => entry.status !== "passed" && entry.reason)
        .map((entry) => ({ scenarioId: entry.id, reason: entry.reason! })),
    );
    if (result.verdict === "rejected" && split.code.length > 0) {
      return {
        ...functional,
        verdict: "rejected",
        failedScenarios: split.code,
        // A function the reviewer could not find on the screen is a failure in
        // the code, so it counts against convergence like any other.
        codeFailedScenarios: split.code,
        artifact,
      };
    }
    if (result.verdict === "rejected" && this.options.recordFriction) {
      // Every scenario the reviewer refused, it refused because of the box.
      // The round accepts on the functional lane and the reason is recorded,
      // so nobody has to read a rejection that says nothing about the code.
      await this.options.recordFriction({
        cardId: input.context.cardId,
        runId: input.runId,
        kind: "ui_review_environment",
        detail: `the review failed only on the environment: ${split.environment.join(", ")}`,
      });
    }
    if (inconclusive.length > 0 && appFailure === null && this.options.recordFriction) {
      // A scenario the reviewer could not reach a verdict on must not park the
      // card: 03 section 8.6 keeps an environment failure out of the failed
      // set. It is still our defect, so it is recorded as friction with the
      // scenarios named rather than silently accepted.
      await this.options.recordFriction({
        cardId: input.context.cardId,
        runId: input.runId,
        kind: "ui_review_inconclusive",
        detail: inconclusive.map((entry) => `${entry.id}: ${entry.reason}`).join("; "),
      });
    }
    return { ...functional, artifact };
  }
}

/** The review that did not happen because the application never came up. */
function unavailableReview(reason: string): UiReviewResult {
  return {
    verdict: "inconclusive",
    failedScenarios: [],
    acceptance: [],
    findings: [],
    amendments: [],
    validationErrors: [],
    runnerFailure: reason,
    reviewSessionId: "",
    images: 0,
    events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  };
}
