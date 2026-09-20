import { refusableStatements, screenScenarios, seedOf, type DefinitionOfDone, type DoDScenario } from "../pipeline/dod.js";
import {
  type EnvironmentJudgeSettings,
  judgeEnvironmentReasons,
  renderMovedReasons,
} from "../judge/environment-reasons.js";
import { splitScenarioFailures } from "../pipeline/failure-classification.js";
import { AppUnderReview } from "../verify/app-under-review.js";
import { reserveAppPort } from "../verify/app-lane.js";
import type { DesignToken } from "../pipeline/interface-contract.js";
import {
  allowedValues,
  contractViolations,
  describeContractViolations,
  type ContractEnforcement,
  type ContractViolation,
} from "../verify/ui-contract.js";
import { CONTRACT_PROPERTIES } from "../verify/ui-contract.js";
import { describeAccessibilityViolations } from "../verify/accessibility-audit.js";
import { CONTRACT_MAX_ELEMENTS, type StyleCollectorPort } from "../verify/ui-contract-collector.js";
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
  /**
   * The contract layer (design 08 section 6): every colour and size on the
   * screen has to come from the token table. Absent means the repository has
   * no interface contract, which is every repository without screens.
   */
  uiContract?: {
    enforce: ContractEnforcement;
    /** The token table on the branch under review, or null when there is none. */
    tokens: () => Promise<readonly DesignToken[] | null>;
    /** Opens the running application. Closed by this port when it is done. */
    collector: () => Promise<StyleCollectorPort & { close(): Promise<void> }>;
  };
  /** A review that could not run says nothing about the Story; it is our problem. */
  recordFriction?: (input: { cardId: string; runId: string; kind: string; detail: string }) => Promise<void>;
  /** Asked only about the refusals the pattern table did not recognise. This
   * lane needs it most: the reviewer stands its own harness up, so its
   * refusals are prose about a box it built itself rather than a runner's
   * formatted output. Absent means the table is the whole answer. */
  environmentJudge?: EnvironmentJudgeSettings;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    // Not a URL the reviewer's browser could open; the allowlist stays as it was.
    return null;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);

/**
 * Moves a page the blind verifier reached onto the instance this lane started.
 *
 * The two lanes each run their own copy of the application, and the verifier's
 * copy is gone by the time the contract layer runs -- it recorded
 * `http://127.0.0.1:4311/costs?...` and that port answers nothing any more, so
 * every page came back unreadable and the one layer that is allowed to refuse
 * on the token table measured nothing at all.
 *
 * Only a loopback origin is rewritten. A page on some other host is not this
 * application and guessing it is would point the browser somewhere nobody
 * asked for.
 */
export function onAppOrigin(url: string, appUrl: string | undefined): string {
  if (!appUrl) return url;
  try {
    const page = new URL(url);
    if (!LOOPBACK.has(page.hostname)) return url;
    const app = new URL(appUrl);
    page.protocol = app.protocol;
    page.host = app.host;
    return page.toString();
  } catch {
    // Not a URL either side could open; the collector reports it as it is.
    return url;
  }
}

/**
 * Why the contract layer read nothing, when the reason is that this lane has no
 * application of its own to read. It names the setting rather than the symptom:
 * `verify.appStartCommand` empty is the whole of it, and until it is filled in
 * the token-table layer measures no repository at all.
 */
const NO_APPLICATION = "the contract layer had no application to open";

/**
 * Why this round has no application, in the layer's own words.
 *
 * There are two reasons and they ask for different things: a repository that
 * declares no way to start has nothing to fix, while one whose application
 * refused to come up has a box to repair. One sentence for both said
 * `verify.appStartCommand is empty for this repository` beside a friction
 * record holding that very command, which is how the round that launched the
 * console with a literal `{port}` read as a repository that starts nothing.
 */
function noApplicationReason(startFailure: string | null): string {
  return startFailure === null
    ? `${NO_APPLICATION}: verify.appStartCommand is empty for this repository, `
      + "so this lane starts nothing and the blind lane's instance has already stopped"
    : `${NO_APPLICATION}: it was started for this round and did not come up -- ${startFailure}`;
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
/** What the contract layer found, kept apart from the review's own findings:
 * one is a finite check with a veto the deployment may switch on, the other is
 * taste and never gets one. */
interface ContractCheck {
  violations: ContractViolation[];
  /** What axe-core found, by scenario. Judged with the token table because it
   * asks the same kind of question: a finite set of rules, each of which the
   * page either breaks or does not. */
  inaccessible: Array<{ page: string; text: string }>;
  /** Pages the layer could not open. Never a violation: a page that would not
   * render has already failed the structural layer, and reporting it twice
   * would read as two problems. */
  failures: string[];
}

export class UiReviewedVerifyPort implements StoryVerifyPort {
  constructor(private readonly options: UiReviewedVerifyPortOptions) {}

  /**
   * Opens each page the round reached and checks its computed styles against
   * the token table. One browser for the whole round, closed here whatever
   * happens: a leaked Chromium outlives the card.
   */
  private async checkContract(
    pages: ReadonlyArray<{ scenarioId: string; url: string }>,
    reviewable: ReadonlySet<string>,
    appUrl: string | undefined,
    startFailure: string | null,
  ): Promise<ContractCheck> {
    const options = this.options.uiContract;
    if (!options || options.enforce === "off") return { violations: [], inaccessible: [], failures: [] };
    const tokens = await options.tokens();
    // No token table means nothing to measure against. It is not a violation:
    // a repository without an interface contract has made no promise to break.
    if (!tokens || tokens.length === 0) return { violations: [], inaccessible: [], failures: [] };
    const wanted = pages.filter((page) => reviewable.has(page.scenarioId));
    if (wanted.length === 0) return { violations: [], inaccessible: [], failures: [] };
    // Every URL here belongs to the blind lane's application, which stopped
    // when that lane finished. Without an instance of our own there is nowhere
    // to move them to, so the layer cannot read a single page. Said once, in
    // those words: opening them anyway reported one refused connection per
    // scenario, which reads like a few flaky pages rather than a layer that
    // has never run on this repository.
    if (appUrl === undefined) {
      return { violations: [], inaccessible: [], failures: [noApplicationReason(startFailure)] };
    }

    const collector = await options.collector();
    const violations: ContractViolation[] = [];
    const inaccessible: Array<{ page: string; text: string }> = [];
    const failures: string[] = [];
    try {
      // Sorted so two runs of one round report the same findings in the same
      // order, and one page per scenario: the same URL under two scenarios is
      // one screen, and reading it twice would double every finding on it.
      const seen = new Set<string>();
      for (const page of [...wanted].toSorted((left, right) =>
        left.scenarioId < right.scenarioId ? -1 : left.scenarioId > right.scenarioId ? 1 : 0)
      ) {
        if (seen.has(page.url)) continue;
        seen.add(page.url);
        try {
          const styles = await collector.collect(page.url, CONTRACT_PROPERTIES, CONTRACT_MAX_ELEMENTS);
          violations.push(...contractViolations(
            page.scenarioId,
            styles,
            allowedValues(tokens, styles.rootFontSizePx),
          ));
          for (const text of describeAccessibilityViolations(
            page.scenarioId,
            await collector.audit?.(page.url) ?? [],
          )) {
            inaccessible.push({ page: page.scenarioId, text });
          }
        } catch (cause) {
          failures.push(`${page.scenarioId}: ${cause instanceof Error ? cause.message : "did not render"}`);
        }
      }
    } finally {
      await collector.close().catch(() => undefined);
    }
    return { violations, inaccessible, failures };
  }

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
    let contract: ContractCheck = { violations: [], inaccessible: [], failures: [] };
    let appFailure: string | null = null;
    const seedFailures: string[] = [];
    // Scenarios whose declared sample data actually reached the application.
    // The rest are told to the reviewer as data nobody staged, because a
    // prompt that claims otherwise has it judge the screen against records
    // that are not there.
    const staged = new Set<string>();
    try {
      let appUrl: string | undefined;
      if (handle && app) {
        // The same port reservation the blind lane makes. Without it this lane
        // starts the application with the literal `{port}` and judges a round
        // of screens nothing was ever serving.
        let substitute: ((text: string) => string) | null = null;
        try {
          substitute = await reserveAppPort([...app.startCommand, app.readyUrl, ...app.seedCommand]);
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          appFailure = `No port could be reserved for the application this round: ${reason}`;
        }
        const replace = substitute ?? ((text: string): string => text);
        if (appFailure === null) {
          const started = await handle.start({
            cwd: this.options.worktreePath,
            command: app.startCommand.map(replace),
            readyUrl: replace(app.readyUrl),
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
                  command: app.seedCommand.map(replace),
                  scenarioId: scenario.id,
                  seed,
                });
                if (seeded.ok) staged.add(scenario.id);
                else seedFailures.push(`${scenario.id}: ${seeded.output}`);
              }
            }
          } else {
            appFailure = started.reason;
          }
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
            if (seed !== undefined) {
              if (staged.has(scenario.id)) item.seed = seed;
              else item.unstagedSeed = seed;
            }
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
      // While the application is still up: the contract layer opens the pages
      // the round reported reaching and reads their computed styles. After the
      // finally block there is nothing left to open. The URLs come from the
      // blind lane, whose own copy of the application is already gone, so they
      // are moved onto this lane's instance first.
      contract = await this.checkContract(
        (functional.pages ?? []).map((page) => ({
          scenarioId: page.scenarioId,
          url: onAppOrigin(page.url, appUrl),
        })),
        reviewable,
        appUrl,
        appFailure,
      );
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
      ...(contract.violations.length === 0 && contract.inaccessible.length === 0 && contract.failures.length === 0
        ? {}
        : {
          uiContract: {
            enforce: this.options.uiContract?.enforce ?? "off",
            violations: contract.violations,
            text: [
              ...describeContractViolations(contract.violations),
              ...contract.inaccessible.map((entry) => entry.text),
            ].join("\n"),
            ...(contract.failures.length === 0 ? {} : { unreadable: contract.failures }),
          },
        }),
    });

    // What the reviewer could not see because the box misbehaved is not a
    // failure of the code, and the reviewer stands its own harness up: a 500 it
    // meets may well be its own. The same split the functional lane applies.
    const reviewReasons = result.acceptance
      .filter((entry) => entry.status !== "passed" && entry.reason)
      .map((entry) => ({ scenarioId: entry.id, reason: entry.reason! }));
    const judged = await judgeEnvironmentReasons(
      this.options.environmentJudge?.judge,
      reviewReasons.map((entry) => entry.reason),
      {
        model: this.options.environmentJudge?.model ?? "",
        threshold: this.options.environmentJudge?.threshold ?? 1,
      },
    );
    if (judged.moved.length > 0 && this.options.recordFriction) {
      // Recorded whether or not it changed the verdict: this is the only place
      // the pattern table's misses become countable, and the count is what
      // decides whether asking is worth keeping.
      await this.options.recordFriction({
        cardId: input.context.cardId,
        runId: input.runId,
        kind: "ui_review_environment_judged",
        detail: renderMovedReasons(judged.moved),
      });
    }
    // The contract layer's own outcome, kept separate from the review's until
    // here: `warn` records what it found and lets the round through, `block`
    // fails the scenarios that carry it. Which one is a deployment's decision
    // (`uiContract.enforce`), not this round's.
    const contractFailures = this.options.uiContract?.enforce === "block"
      ? [...new Set([
        ...contract.violations.map((violation) => violation.page),
        ...contract.inaccessible.map((entry) => entry.page),
      ])].toSorted()
      : [];
    const missingApplication = contract.failures.find((failure) => failure.startsWith(NO_APPLICATION));
    if (missingApplication !== undefined && this.options.recordFriction) {
      // Counted like every other gap this file records: 08 section 6 gives the
      // contract layer a veto once it has earned one, and a layer that has
      // never opened a page cannot have earned anything. This is the number
      // that says so.
      await this.options.recordFriction({
        cardId: input.context.cardId,
        runId: input.runId,
        kind: "ui_contract_no_app",
        detail: missingApplication,
      });
    }
    if ((contract.violations.length > 0 || contract.inaccessible.length > 0) && this.options.recordFriction) {
      // Recorded whether or not it refused: the count is what decides whether
      // this layer is ready to be given a veto (08 section 6).
      await this.options.recordFriction({
        cardId: input.context.cardId,
        runId: input.runId,
        kind: this.options.uiContract?.enforce === "block" ? "ui_contract_blocked" : "ui_contract_warned",
        detail: [
          ...describeContractViolations(contract.violations),
          ...contract.inaccessible.map((entry) => entry.text),
        ].join("; "),
      });
    }
    const split = splitScenarioFailures(result.failedScenarios, reviewReasons, judged.environmental);
    const refused = [...new Set([
      ...(result.verdict === "rejected" ? split.code : []),
      ...contractFailures,
    ])].toSorted();
    if (refused.length > 0) {
      return {
        ...functional,
        verdict: "rejected",
        failedScenarios: refused,
        // A function the reviewer could not find on the screen, or a value
        // that came from outside the token table, is a failure in the code, so
        // it counts against convergence like any other.
        codeFailedScenarios: refused,
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
