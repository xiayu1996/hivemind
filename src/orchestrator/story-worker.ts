import { randomUUID } from "node:crypto";
import {
  classifyConvergence,
  renderConvergenceReport,
  type ConvergenceClassification,
  type ConvergenceOptions,
  type ConvergenceResult,
} from "../pipeline/convergence.js";
import type { MergeFailureAttribution } from "../vcs/merge-flow.js";
import { evaluateSpecExit, applyDowngrades, renderSpecExitFindings, type SpecExitPorts } from "../pipeline/spec-exit-gate.js";
import { parseTestContract, TestContractValidationError, type TestContract } from "../pipeline/test-contract.js";
import { costCeilingVerdict, renderCostCeilingReport, type CardSpend } from "../pipeline/cost-ceiling.js";
import {
  DoDValidationError,
  hasScreen,
  lintDoDLanguage,
  parseDoD,
  renderDoDLanguageFindings,
  renderMissingInterfaceContract,
  renderMissingPage,
  renderMissingVisible,
  footprintWithoutGround,
  renderFootprintWithoutGround,
  scenariosMissingPage,
  scenariosMissingVisible,
  type DefinitionOfDone,
} from "../pipeline/dod.js";
import { assemblePhasePrompt, type PhaseInput } from "../pipeline/phase-input.js";
import {
  renderUnreachableScreens,
  screenPages,
  type ScreenPage,
  type UnreachableScreen,
} from "../pipeline/screen-reachability.js";
import type { InterfaceContract } from "../pipeline/interface-contract.js";
import {
  StoryExecutionStore,
  type StoryPhase,
  type StorySnapshot,
} from "./story-execution-store.js";
import type { StoryState } from "./state-machine.js";
import type { ResolvedAgentSpec } from "../runner/agent-spec.js";
import { describeOrphanedCard } from "../regression/orphaned-cards.js";

export interface ManagedPhaseInput {
  runId: string;
  phase: Exclude<StoryPhase, "VERIFY">;
  round: number;
  prompt: string;
  context: PhaseInput;
  /**
   * Which try at this (phase, round) this is. Failover and crash recovery both
   * spawn again inside one round, and two spawns must not land on the same
   * session file: pi would continue the earlier conversation, which is the
   * session fork the invariants forbid, happening silently.
   */
  attempt?: number;
  /** A restart continuing the same attempt, which legitimately finds messages. */
  resuming?: boolean;
  /** Deterministic exits the port enforces inside the live session, in order.
   * The port adds its own for the phases that have one. */
  exitGates?: readonly PhaseExitGate[];
}

/**
 * A phase's own exit check, handed back to the session that produced the
 * output rather than returned as a verdict on the Story.
 *
 * Refusing in a new session is the expensive way to do this: the work has to
 * be redone from a prompt instead of corrected in place, and the refusal reads
 * downstream as a phase that failed. S-AGENTRULES-01 stopped on two SPECIFY
 * refusals that a single sentence back into the same session would have fixed.
 */
export interface PhaseExitGate {
  /** Names the gate in errors, telemetry and friction records. */
  name: string;
  /** Judges what the phase produced. Findings are what the session is told. */
  evaluate(
    artifacts: readonly { kind: string; body: string }[],
    attempt: number,
  ): Promise<{ passed: true } | { passed: false; findings: string }>;
  /** How many times this gate may judge inside one session. */
  maxRounds: number;
  /**
   * What happens when the rounds run out. `fail` refuses the phase; `ship`
   * lets the output through as written, which is right where the gate has no
   * veto -- a delivery report that still reads technically is worth a rewrite,
   * never a stalled card (03 section 8.2).
   */
  exhausted: "fail" | "ship";
  /** The error a `fail` gate raises, when a bare refusal loses information the
   * next attempt needs. Defaults to `PhaseExitNotMetError`. */
  failure?(findings: string): Error;
}

export interface ManagedPhaseResult {
  sessionId: string;
  artifacts: Array<{ kind: string; body: string }>;
  /** What the phase actually ran on, when the port resolved one. */
  spec?: ResolvedAgentSpec;
  /** How many times each exit gate judged this phase, by gate name. A gate
   * that judged more than once had to send the phase back at least that often,
   * which is what tells whether a rule is earning its place. */
  exitGateRounds?: Record<string, number>;
}

export interface StoryPhasePort {
  run(input: ManagedPhaseInput): Promise<ManagedPhaseResult>;
}

export interface ManagedVerifyInput {
  runId: string;
  round: number;
  /** Which try at this round this is, so its session file is its own. */
  attempt?: number;
  prompt: string;
  context: PhaseInput;
  codeSessionId: string;
  definitionOfDone: DefinitionOfDone;
}

export interface ManagedVerifyResult {
  sessionId: string;
  verdict: "accepted" | "rejected" | "inconclusive";
  failedScenarios: string[];
  /** The subset of `failedScenarios` that failed for a reason in the code.
   * Absent means every failure counts, which is what a port that cannot tell
   * the difference has to assume. */
  codeFailedScenarios?: string[];
  evidenceDir?: string;
  screenshots?: Array<{ scenarioId: string; path: string }>;
  /** The page each scenario reached, for a lane that opens it again while the
   * application is still up. */
  pages?: Array<{ scenarioId: string; url: string }>;
  artifact: string;
}

export interface StoryVerifyPort {
  run(input: ManagedVerifyInput): Promise<ManagedVerifyResult>;
}

export interface StoryDeliveryPort {
  deliver(input: {
    story: StorySnapshot;
    mergeArtifact: string;
  }): Promise<{ mrUrl: string | null }>;
}

export interface StoryProjectionPort {
  enqueue(cardId: string): Promise<void>;
}

export interface StoryFrictionPort {
  /** Records that the pipeline, not the Story, is what failed. Feeds the
   * reflection pipeline; see 03 section 4. */
  record(input: { cardId: string; runId: string; kind: string; detail: string }): Promise<void>;
}

export interface StoryIntegrationPort {
  /** Puts the Story on its Epic head. `publish` opens the Story's review
   * request while the rebased branch is still ahead of the head; its URL comes
   * back on a merged result. A result other than "merged" has already returned
   * the Story to CODE; the run stops without delivering again. */
  integrate(
    cardId: string,
    runId: string,
    publish?: () => Promise<{ mrUrl: string | null }>,
  ): Promise<{
    kind: string;
    reason?: string | undefined;
    mrUrl?: string | null | undefined;
    /** Why the re-verification refused it, which decides what it costs. */
    attribution?: MergeFailureAttribution | undefined;
    failures?: readonly string[] | undefined;
    /** On a conflict: the branch it was landing on and the paths the rebase
     * could not reconcile. */
    integrationBranch?: string | undefined;
    files?: readonly string[] | undefined;
  }>;
}

export interface StoryWorkerOptions {
  maxInnerLoopRounds?: number;
  /** Handbacks inside one SPECIFY session before the phase has failed. Read
   * from `specifyExit.maxRounds`. */
  specifyExitRounds?: number;
  /** How many times the regression loop may reopen a delivered Story. */
  maxRegressionReopens?: number;
  /** How many consecutive verification attempts may be lost to the environment
   * before the card stops for a person as `retry_limit_exceeded`. The attempts
   * cost no inner-loop budget and leave the CODE HEAD alone; this is what keeps
   * a broken host from re-verifying forever. */
  maxInconclusiveRounds?: number;
  integration?: StoryIntegrationPort;
  friction?: StoryFrictionPort;
  spend?: StorySpendPort;
  /** How many earlier rounds an identical failure set is looked for in before
   * the loop is called oscillating. Read from `retry.oscillationLookback`. */
  convergence?: ConvergenceOptions;
  /** Only a caller that owns a worktree can prove a test is red. Without it the
   * test contract is still recorded, and nothing about it is proved. */
  specify?: StorySpecifyGate;
  /** The tree a verdict was reached on. Without it a conclusion cannot be tied
   * to a tree, so nothing is carried forward and every round re-verifies in
   * full -- which is the behaviour a caller with no worktree should get. */
  treeSha?: () => Promise<string>;
  /** The interface contract on the branch this card runs on, read once per
   * phase. Every phase that puts something on a screen is built against it, so
   * it is injected wherever it exists; a card in a repository with no screens
   * never sees the section. */
  interfaceContract?: () => Promise<InterfaceContract | null>;
  /**
   * Whether a path exists in the tree this card runs on, used to judge the
   * footprint the DoD declares. Synchronous because the exit asks about a
   * handful of paths at most and a predicate keeps the rule itself pure.
   *
   * Optional for the same reason the other tree ports are: a caller with no
   * worktree records the footprint unchecked, which is all it can do.
   */
  repositoryHas?: (path: string) => boolean;
  /**
   * Opens each screen the DoD promises on the application this repository
   * starts, and says which ones were not there.
   *
   * `null` when the repository declares no way to start one: there is no
   * entry point to ask about, so nothing is asked. Optional for the same
   * reason as the other tree ports -- a caller with no worktree cannot start
   * anything.
   */
  screensReachable?: (pages: readonly ScreenPage[]) => Promise<UnreachableScreen[] | null>;
  runId?: (cardId: string, phase: StoryPhase, round: number) => string;
}

/**
 * What one card has spent, and what it is allowed to spend.
 *
 * Optional because it only means anything where a provider is billed per token:
 * a host running a flat-rate subscription has no money to cap, and giving it a
 * port that always answers zero would read as a ceiling being enforced when
 * nothing is.
 */
export interface StorySpendPort {
  cardSpend(cardId: string): Promise<CardSpend>;
  ceilingUsd(): Promise<number>;
  spendByPhase?(cardId: string): Promise<ReadonlyMap<string, number>>;
}

/**
 * What the SPECIFY exit needs from the repository: where the card sits now, and
 * how to clean, run and freeze its tree.
 *
 * Optional on the worker for the same reason the CODE exit is: a caller with no
 * real worktree (a test, a replay) still needs to drive the phase. The real
 * entry point always supplies one, and without it SPECIFY records its contract
 * but proves nothing -- which is why nothing but a test should omit it.
 */
export interface StorySpecifyGate {
  /** The commit this execution enters on; the tree-pin's baseline. */
  baseCommit(): Promise<string>;
  testPathPatterns(): readonly string[];
  ports(cardId: string): SpecExitPorts;
}

export interface StoryWorkerResult {
  /** MERGE means the Story is finished and waiting on its Epic head, not on
   * itself: the branch it is landing on is failing a check without it. */
  state: "DELIVERED" | "NEEDS_INPUT" | "CODE" | "MERGE";
  rounds: number;
  mrUrl: string | null;
  stopReason: "blocking_question" | "verify_loop_exceeded" | "retry_limit_exceeded" | "cost_ceiling_exceeded" | null;
  /** How the convergence check classified the loop, when one stopped it.
   * Four different situations used to be written down as one reason, so a
   * person reading the card could not tell "went in circles from round two"
   * from "spent its whole budget". */
  convergence?: ConvergenceClassification;
  /** Attached to the card when the run stopped; business language, no thresholds alone. */
  stopReport?: string;
}

function artifact(result: ManagedPhaseResult, kind: string): string {
  return artifactOf(result.artifacts, kind);
}

function artifactOf(artifacts: readonly { kind: string; body: string }[], kind: string): string {
  const found = artifacts.find((item) => item.kind === kind);
  if (!found) throw new Error(`phase result is missing required artifact: ${kind}`);
  return found.body;
}

/** Executes one Story on one host through DESIGN, CODE/VERIFY and MERGE. */
export class SingleStoryWorker {
  private readonly maxInnerLoopRounds: number;
  private readonly maxRegressionReopens: number;
  private readonly maxInconclusiveRounds: number;
  private readonly specifyExitRounds: number;
  private readonly friction: StoryFrictionPort | undefined;
  private readonly createRunId: (cardId: string, phase: StoryPhase, round: number) => string;
  private readonly integration: StoryIntegrationPort | undefined;
  private readonly spend: StorySpendPort | undefined;
  private readonly specifyGate: StorySpecifyGate | undefined;
  private readonly convergenceOptions: ConvergenceOptions;
  private readonly treeSha: (() => Promise<string>) | undefined;
  private readonly interfaceContract: (() => Promise<InterfaceContract | null>) | undefined;
  private readonly repositoryHas: ((path: string) => boolean) | undefined;
  private readonly screensReachable: StoryWorkerOptions["screensReachable"];

  constructor(
    private readonly store: StoryExecutionStore,
    private readonly phases: StoryPhasePort,
    private readonly verifier: StoryVerifyPort,
    private readonly delivery: StoryDeliveryPort,
    private readonly projection: StoryProjectionPort,
    options: StoryWorkerOptions = {},
  ) {
    this.integration = options.integration;
    this.friction = options.friction;
    this.spend = options.spend;
    this.specifyGate = options.specify;
    this.convergenceOptions = options.convergence ?? {};
    this.treeSha = options.treeSha;
    this.interfaceContract = options.interfaceContract;
    this.repositoryHas = options.repositoryHas;
    this.screensReachable = options.screensReachable;
    this.maxInconclusiveRounds = options.maxInconclusiveRounds ?? 2;
    this.maxInnerLoopRounds = options.maxInnerLoopRounds ?? 3;
    this.specifyExitRounds = options.specifyExitRounds ?? 3;
    this.maxRegressionReopens = options.maxRegressionReopens ?? 2;
    if (!Number.isInteger(this.maxInnerLoopRounds) || this.maxInnerLoopRounds < 1) {
      throw new Error("maxInnerLoopRounds must be a positive integer");
    }
    this.createRunId = options.runId ?? ((cardId, phase, round) => {
      const safeCardId = cardId.replaceAll(/[^A-Za-z0-9._-]/g, "-");
      return `${safeCardId}-${phase.toLowerCase()}-${round}-${randomUUID()}`;
    });
  }

  /**
   * Stops the card if it has already reached the money one card may spend.
   *
   * Checked at a phase boundary, which is the finest granularity available: a
   * turn cannot be interrupted partway, and the spend of the turn about to start
   * is unknown until it ends. So the ceiling is a floor on the overrun, not an
   * exact cut — a card stops once it has crossed the line, not before it can.
   *
   * Deliberately separate from the round budget. Rounds answer whether the
   * system is going in circles; this answers how much one card may cost. A
   * spend stop says nothing about whether the work is achievable, and the report
   * says so, because the two get confused by whoever reads the card.
   */
  async #costCeilingStop(
    cardId: string,
    fromState: StoryState,
    round: number,
  ): Promise<StoryWorkerResult | null> {
    if (!this.spend) return null;
    const spent = await this.spend.cardSpend(cardId);
    const verdict = costCeilingVerdict(spent, await this.spend.ceilingUsd());
    if (!verdict.exceeded) return null;

    const byPhase = (await this.spend.spendByPhase?.(cardId)) ?? new Map<string, number>();
    const runId = this.createRunId(cardId, "VERIFY", round);
    await this.store.stopForInput(cardId, fromState, "cost_ceiling_exceeded", runId);
    await this.projection.enqueue(cardId);
    return {
      state: "NEEDS_INPUT",
      rounds: round,
      mrUrl: null,
      stopReason: "cost_ceiling_exceeded",
      stopReport: renderCostCeilingReport(cardId, verdict, spent, byPhase),
    };
  }

  async run(cardId: string): Promise<StoryWorkerResult> {
    let story = await this.store.getStory(cardId);
    if (story.state === "REGRESSION_FIX") return this.regressionFixLoop(cardId, story);
    // A delivered card the regression loop reopened enters at SPECIFY with its
    // phase still naming where it is headed. The marker is what separates this
    // from a card that is simply at SPECIFY on its way to CODE.
    if (story.state === "SPECIFY" && story.phase === "REGRESSION_FIX") {
      return this.regressionEntry(cardId, story);
    }
    // A run that died inside VERIFY (a killed process, a provider transport
    // fault) leaves the Story in a state no phase starts from. The round it
    // lost recorded no verification, so it cost no budget: the card goes back
    // to CODE and the inner loop buys the round again. Without this a single
    // transport fault parks the card and blocks its Epic for good.
    if (story.state === "VERIFY") {
      const resumeRunId = this.createRunId(cardId, "VERIFY", story.innerLoopRounds);
      await this.store.transition(cardId, "VERIFY", "CODE", "system", resumeRunId);
      await this.friction?.record({
        cardId,
        runId: resumeRunId,
        kind: "verification_interrupted",
        detail: `round ${story.innerLoopRounds} left VERIFY without a verdict`,
      });
      story = await this.store.getStory(cardId);
    }
    let definitionOfDone: DefinitionOfDone;
    // VERIFY already accepted: re-entering at MERGE skips the inner loop and
    // redoes only the delivery report plus branch publication.
    let mergeOnly = story.state === "MERGE";
    if (story.state === "CODE" || story.state === "MERGE") {
      // The frozen DoD is read under today's contract. One the contract no
      // longer accepts cannot drive VERIFY, so the Story is shaped again
      // rather than failing every attempt until a person notices. SHAPE, not
      // DESIGN: the acceptance contract is a requirement artifact, and the
      // phase that owns it is the one that may ask about it.
      try {
        await this.store.getDefinitionOfDone(cardId);
      } catch (cause) {
        if (!(cause instanceof DoDValidationError)) throw cause;
        const reshapeRunId = this.createRunId(cardId, "SHAPE", 1);
        await this.store.resetForRedesign(cardId, cause.message);
        await this.store.transition(cardId, story.state, "SHAPE", "system", reshapeRunId);
        await this.friction?.record({ cardId, runId: reshapeRunId, kind: "dod_contract_changed", detail: cause.message });
        story = await this.store.getStory(cardId);
        mergeOnly = false;
      }
    }
    if (mergeOnly) {
      definitionOfDone = await this.store.getDefinitionOfDone(cardId);
    } else if (story.state === "QUEUED" || story.state === "SHAPE" || story.state === "DESIGN"
               || story.state === "SPECIFY") {
      const front = await this.runFrontPhases(cardId, story.state);
      if (front.stopped) return front.stopped;
      definitionOfDone = front.definitionOfDone;
    } else if (story.state === "CODE") {
      definitionOfDone = await this.store.getDefinitionOfDone(cardId);
    } else {
      throw new Error(`Story ${cardId} must be QUEUED, SHAPE, DESIGN, SPECIFY, CODE or MERGE, not ${story.state}`);
    }

    let mergeRunId = "";
    let totalRounds = mergeOnly ? story.innerLoopRounds : 0;
    if (!mergeOnly) {
      // The budget counts the rounds since a person last acted on the card: a
      // resume is a decision to spend more, not a replay of the spent rounds.
      // CODE, VERIFY and MERGE are one loop, so a merge this Story's own work
      // broke has already taken a round out of the same budget.
      const failureHistory = await this.store.getVerificationFailureHistory(cardId, story.lastHumanActionAt ?? 0);
      const alreadySpent = await this.store.getInnerLoopSpend(cardId, story.lastHumanActionAt ?? 0);
      // Round numbers keep counting across resumes; the budget does not.
      let round = story.innerLoopRounds;
      if (alreadySpent >= this.maxInnerLoopRounds) {
        // The Epic head refused the branch after the budget was already spent:
        // there is no round left to fix it in, so the card stops on the budget.
        const stopRunId = this.createRunId(cardId, "VERIFY", round);
        await this.store.stopForInput(cardId, story.state, "retry_limit_exceeded", stopRunId, {
          convergence: "budget_exhausted",
          spent: alreadySpent,
          budget: this.maxInnerLoopRounds,
          failed: failureHistory.at(-1) ?? [],
        });
        await this.projection.enqueue(cardId);
        return { state: "NEEDS_INPUT", rounds: round, mrUrl: null, stopReason: "retry_limit_exceeded" };
      }
      // `spent` is the budget: only a round that failed in the code costs one.
      let spent = alreadySpent;
      let inconclusiveStreak = 0;
      while (spent < this.maxInnerLoopRounds) {
        // Before buying another CODE turn, not after: the ceiling exists to stop
        // the next purchase, and a card resumed by a person who raised it starts
        // the round it was stopped before.
        // Every path into this loop has already transitioned the card to CODE,
        // so the snapshot's own state is stale here and the guarded UPDATE
        // would find no row.
        const overspent = await this.#costCeilingStop(cardId, "CODE", round);
        if (overspent) return overspent;
        round += 1;
        const codeRunId = this.createRunId(cardId, "CODE", round);
        const screenGate = this.screenGate(cardId, codeRunId);
        const code = await this.runPhase(cardId, "CODE", round, codeRunId, screenGate ? [screenGate] : undefined);
        artifact(code, "implementation");
        let verifyRunId = this.createRunId(cardId, "VERIFY", round);
        await this.store.transition(cardId, "CODE", "VERIFY", "system", verifyRunId);
        let verification = await this.runVerification(
          cardId,
          round,
          verifyRunId,
          code.sessionId,
          definitionOfDone,
        );
        await this.projection.enqueue(cardId);

        // A round the box lost is retried against the same CODE output. Going
        // back to CODE would buy a model turn to fix something the code never
        // did - S-E2RESULTS-01 spent rounds 11 and 12 rewriting a page whose
        // only fault was a dev server that was not listening - and it would
        // move the HEAD the next attempt is judged on, so a retry could no
        // longer be compared with the attempt it repeats. Re-verifying stands
        // the environment up again, which is the repair for the cases this
        // reaches: a port somebody else held, a server that died, a browser
        // that failed to launch.
        while (verification.verdict === "inconclusive") {
          inconclusiveStreak += 1;
          if (inconclusiveStreak >= this.maxInconclusiveRounds) {
            await this.friction?.record({
              cardId,
              runId: verifyRunId,
              kind: "verification_inconclusive",
              detail: `${inconclusiveStreak} consecutive attempts failed for environmental reasons: ${verification.failedScenarios.join(", ")}`,
            });
            // Named, because this stop is not about the work: nothing was
            // judged at all. Without the detail the card offered a person the
            // words "retry limit exceeded" over an environment that never came
            // up, and a fabricated budget of zero underneath them.
            await this.store.stopForInput(cardId, "VERIFY", "retry_limit_exceeded", verifyRunId, {
              inconclusive: inconclusiveStreak,
              inconclusiveScenarios: verification.failedScenarios,
            });
            await this.projection.enqueue(cardId);
            return { state: "NEEDS_INPUT", rounds: round, mrUrl: null, stopReason: "retry_limit_exceeded" };
          }
          // A new round number, because one phase run per (card, phase, round)
          // is what makes a resumed card idempotent. `spent` stays put: the
          // number counts what the code was judged on, and this attempt was
          // not.
          round += 1;
          verifyRunId = this.createRunId(cardId, "VERIFY", round);
          verification = await this.runVerification(
            cardId,
            round,
            verifyRunId,
            code.sessionId,
            definitionOfDone,
          );
          await this.projection.enqueue(cardId);
        }
        inconclusiveStreak = 0;

        if (verification.verdict === "accepted" && verification.failedScenarios.length === 0) {
          const outstanding = await this.settleScenarios(cardId, round);
          if (outstanding.length > 0) {
            // Accepted on what it looked at, but the card as a whole is not
            // proved: a scenario whose wording changed, or whose conclusion was
            // reached on a tree that has since moved, has to be judged again.
            spent += 1;
            failureHistory.push(outstanding);
            await this.store.transition(cardId, "VERIFY", "CODE", "system", verifyRunId);
            continue;
          }
          mergeRunId = this.createRunId(cardId, "MERGE", 1);
          totalRounds = round;
          await this.store.transition(cardId, "VERIFY", "MERGE", "system", mergeRunId);
          break;
        }

        spent += 1;
        failureHistory.push([
          ...new Set(verification.codeFailedScenarios ?? verification.failedScenarios),
        ].toSorted());
        const convergence = classifyConvergence(failureHistory, this.convergenceOptions);
        if (!convergence.mayContinue || spent >= this.maxInnerLoopRounds) {
          // Two different stops, told apart because they call for different
          // decisions. A loop that repeated a round it has already run will
          // repeat it again however much budget it is given, so it stops on the
          // loop; a loop that was still producing new sets when the rounds ran
          // out stops on the budget, and raising the budget is a real option.
          // The loop stop wins when both are true: the repetition is why
          // spending the last round was pointless.
          const stoppedOnLoop = !convergence.mayContinue;
          const classification = stoppedOnLoop ? convergence.classification : "budget_exhausted";
          const reason = stoppedOnLoop ? "verify_loop_exceeded" : "retry_limit_exceeded";
          await this.store.stopForInput(cardId, "VERIFY", reason, verifyRunId, {
            convergence: classification,
            spent,
            budget: this.maxInnerLoopRounds,
            failed: failureHistory.at(-1) ?? [],
          });
          await this.projection.enqueue(cardId);
          return {
            state: "NEEDS_INPUT",
            rounds: round,
            mrUrl: null,
            stopReason: reason,
            convergence: classification,
            stopReport: renderConvergenceReport(cardId, classification, failureHistory),
          };
        }
        await this.store.transition(cardId, "VERIFY", "CODE", "system", verifyRunId);
      }

      if (mergeRunId === "") throw new Error("Story left the verification loop without a merge run");
    } else {
      mergeRunId = this.createRunId(cardId, "MERGE", 1);
    }
    const merge = await this.runPhase(cardId, "MERGE", 1, mergeRunId);
    const mergeArtifact = artifact(merge, "delivery-report");
    story = await this.store.getStory(cardId);
    let mrUrl: string | null;
    if (this.integration && story.epicId) {
      // A Story inside an Epic is delivered by landing on the Epic head. Its
      // draft review request is opened from inside the merge, between the
      // rebase and the fast-forward, which is the only moment it has a diff.
      // Anything but a clean merge is the Story's problem and it has already
      // been sent back to CODE.
      const snapshot = story;
      const integrated = await this.integration.integrate(
        cardId,
        mergeRunId,
        () => this.delivery.deliver({ story: snapshot, mergeArtifact }),
      );
      if (integrated.kind !== "merged") {
        await this.projection.enqueue(cardId);
        // A check that would not start says nothing about the code. Throwing
        // hands it to the crash safety net, which is where an environment
        // failure belongs; charging it to the Story would buy a model turn to
        // fix a missing binary.
        const attribution: MergeFailureAttribution | undefined =
          integrated.kind === "conflict" ? "story_regression" : integrated.attribution;
        // Counted, not just recorded against the card. A rebase conflict is
        // not a defect in the Story and not a judgement on it -- it says two
        // Stories wanted the same ground -- so how often it happens is the
        // number that decides whether the split, the schedule or the branch
        // discipline needs changing.
        if (integrated.kind === "conflict") {
          await this.friction?.record({
            cardId,
            runId: mergeRunId,
            kind: "merge_conflict",
            detail: JSON.stringify({ branch: integrated.integrationBranch, files: integrated.files }),
          });
        }
        if (attribution === "environment") {
          throw new Error(`Story ${cardId} could not be re-verified at merge: ${integrated.reason ?? "the check did not run"}`);
        }
        // An Epic head that was already red is not this Story's round to
        // spend and not its state to leave: it stays in MERGE and lands once
        // the head is green, while the Epic carries the block.
        if (attribution === "baseline_failing") {
          return { state: "MERGE", rounds: totalRounds, mrUrl: null, stopReason: null };
        }
        {
          const spent = await this.store.getInnerLoopSpend(cardId, story.lastHumanActionAt ?? 0);
          if (spent >= this.maxInnerLoopRounds) {
            const stopRunId = this.createRunId(cardId, "CODE", totalRounds);
            await this.store.stopForInput(cardId, "CODE", "retry_limit_exceeded", stopRunId, {
              convergence: "budget_exhausted",
              spent,
              budget: this.maxInnerLoopRounds,
              mergeBounce: integrated.kind === "conflict" ? "conflict" : "story_regression",
              ...(integrated.failures ? { failures: integrated.failures } : {}),
            });
            await this.projection.enqueue(cardId);
            return { state: "NEEDS_INPUT", rounds: totalRounds, mrUrl: null, stopReason: "retry_limit_exceeded" };
          }
        }
        return { state: "CODE", rounds: totalRounds, mrUrl: null, stopReason: null };
      }
      mrUrl = integrated.mrUrl ?? null;
    } else {
      mrUrl = (await this.delivery.deliver({ story, mergeArtifact })).mrUrl;
    }
    await this.store.markDelivered(cardId, mergeRunId, mrUrl);
    await this.projection.enqueue(cardId);
    return {
      state: "DELIVERED",
      rounds: totalRounds,
      mrUrl,
      stopReason: null,
    };
  }

  /**
   * A delivered Story the regression sweep attributed a failure to. The loop
   * is the inner loop with a different writing phase: fix on the Story branch,
   * re-verify only the scenarios the cards name, land on the Epic head again.
   * Entries are counted, not rounds: the ceiling is on how often the same Story
   * may be dragged back, the rounds inside one entry are bounded as usual.
   */
  private async regressionFixLoop(cardId: string, story: StorySnapshot): Promise<StoryWorkerResult> {
    const cards = (await this.store.buildPhaseInput(cardId, "REGRESSION_FIX", story.innerLoopRounds + 1)).regressions ?? [];
    if (cards.length === 0) {
      // Resolved elsewhere or retracted; a Story parked here with nothing to
      // fix would never leave. It leaves through MERGE rather than straight to
      // DELIVERED, because "nothing left to fix" says nothing about whether
      // the work ever landed: the round that reopened this Story may have
      // stopped before its fix reached the Epic head, and delivering from here
      // reports a merge that never happened. Asking MERGE is what makes the
      // tree decide -- a branch already contained fast-forwards to the same
      // head -- instead of guessing from the state a card sits in.
      const runId = this.createRunId(cardId, "REGRESSION_FIX", story.innerLoopRounds);
      if (this.integration === undefined || story.epicId === null) {
        // Nothing to land on. A caller that owns no integration cannot merge,
        // so the Story is as delivered as this host can make it.
        await this.store.transition(cardId, "REGRESSION_FIX", "DELIVERED", "system", runId);
        await this.projection.enqueue(cardId);
        return { state: "DELIVERED", rounds: story.innerLoopRounds, mrUrl: story.mrUrl, stopReason: null };
      }
      await this.store.transition(cardId, "REGRESSION_FIX", "MERGE", "system", runId);
      await this.projection.enqueue(cardId);
      return { state: "MERGE", rounds: story.innerLoopRounds, mrUrl: story.mrUrl, stopReason: null };
    }
    if (!this.integration || !story.epicId) {
      throw new Error(`Story ${cardId} cannot land a regression fix without its Epic integration`);
    }
    if (story.regressionReopens >= this.maxRegressionReopens) {
      const runId = this.createRunId(cardId, "REGRESSION_FIX", story.innerLoopRounds);
      // An open card whose scenario has left the sweep pool needs naming here,
      // not a count: no sweep and no round can ever close it, so a person
      // reading only "reopened twice" is told to wait for something that is
      // never going to happen. S-R237511MB-02-access stopped this way twice.
      const orphans = await this.store.orphanedRegressionCards(cardId);
      // Carries its own numbers: the page showed "重试次数用尽" over a budget
      // that belongs to the inner loop, which this stop is not about.
      await this.store.stopForInput(cardId, "REGRESSION_FIX", "retry_limit_exceeded", runId, {
        spent: story.regressionReopens,
        budget: this.maxRegressionReopens,
        reopened: cards.map((card) => card.scenarioId),
        orphaned: orphans.map((card) => card.scenarioId),
      });
      await this.projection.enqueue(cardId);
      const orphanLines = orphans.map((card) => `\n${describeOrphanedCard(card)}`).join("");
      return {
        state: "NEEDS_INPUT",
        rounds: story.innerLoopRounds,
        mrUrl: story.mrUrl,
        stopReason: null,
        stopReport: `${cardId} stopped: retry.maxRegressionReopens

The regression loop reopened this Story ${story.regressionReopens} times; the cards still open: ${cards.map((card) => card.scenarioId).join(", ")}
${orphanLines}`,
      };
    }
    await this.store.countRegressionReopen(cardId);
    const fullDoD = await this.store.getDefinitionOfDone(cardId);
    const wanted = new Set(cards.map((card) => card.scenarioId));
    const definitionOfDone: DefinitionOfDone = {
      ...fullDoD,
      scenarios: fullDoD.scenarios.filter((scenario) => wanted.has(scenario.id)),
    };

    let round = story.innerLoopRounds;
    const failureHistory: string[][] = [];
    let inconclusiveStreak = 0;
    let convergence: ConvergenceResult | null = null;
    for (let spent = 0; spent < this.maxInnerLoopRounds;) {
      const overspent = await this.#costCeilingStop(cardId, "REGRESSION_FIX", round);
      if (overspent) return overspent;
      round += 1;
      const fixRunId = this.createRunId(cardId, "REGRESSION_FIX", round);
      const fixScreenGate = this.screenGate(cardId, fixRunId);
      const fix = await this.runPhase(cardId, "REGRESSION_FIX", round, fixRunId,
        fixScreenGate ? [fixScreenGate] : undefined);
      artifact(fix, "implementation");
      let verifyRunId = this.createRunId(cardId, "VERIFY", round);
      let verification = await this.runVerification(cardId, round, verifyRunId, fix.sessionId, definitionOfDone);
      await this.projection.enqueue(cardId);

      // Re-verified against the same fix, exactly as the inner loop does it.
      // Going back around the for-loop would buy another REGRESSION_FIX turn
      // to repair something the code never did: S-R237511MB-02 was reopened
      // for a scenario judged from outside the allowed networks, which no
      // browser we can reach comes from, and the turn it bought answered the
      // unreachable premise by rendering the denial page to every caller.
      // Standing the environment up again is the repair for what this reaches;
      // rewriting the tree is not, and it moves the HEAD the next attempt
      // would be compared against.
      while (verification.verdict === "inconclusive") {
        inconclusiveStreak += 1;
        if (inconclusiveStreak >= this.maxInconclusiveRounds) {
          await this.friction?.record({
            cardId,
            runId: verifyRunId,
            kind: "verification_inconclusive",
            detail: `${inconclusiveStreak} consecutive attempts failed for environmental reasons: ${verification.failedScenarios.join(", ")}`,
          });
          await this.store.stopForInput(cardId, "REGRESSION_FIX", "verify_loop_exceeded", verifyRunId, {
            inconclusive: inconclusiveStreak,
            inconclusiveScenarios: verification.failedScenarios,
          });
          await this.projection.enqueue(cardId);
          return { state: "NEEDS_INPUT", rounds: round, mrUrl: story.mrUrl, stopReason: "verify_loop_exceeded" };
        }
        round += 1;
        verifyRunId = this.createRunId(cardId, "VERIFY", round);
        verification = await this.runVerification(cardId, round, verifyRunId, fix.sessionId, definitionOfDone);
        await this.projection.enqueue(cardId);
      }
      inconclusiveStreak = 0;
      spent += 1;
      const failed = [...new Set(verification.codeFailedScenarios ?? verification.failedScenarios)].toSorted();
      if (verification.verdict === "accepted" && failed.length === 0) {
        const landed = await this.integration.integrate(cardId, fixRunId);
        if (landed.kind === "merged") {
          const openCards = await this.store.buildPhaseInput(cardId, "REGRESSION_FIX", round);
          for (const card of openCards.regressions ?? []) {
            await this.store.resolveRegressionCard(card.scenarioId, card.signature, cardId);
          }
          await this.store.transition(cardId, "REGRESSION_FIX", "DELIVERED", "system", fixRunId);
          await this.projection.enqueue(cardId);
          return { state: "DELIVERED", rounds: round, mrUrl: story.mrUrl, stopReason: null };
        }
        // The head refused the fix; the reason is already recorded as this
        // round's task and the loop tries again from the tree as it stands.
        // Every card is still open, so that is the round's failed set.
        failureHistory.push([...wanted].toSorted());
        continue;
      }
      failureHistory.push(failed);
      convergence = classifyConvergence(failureHistory, this.convergenceOptions);
      if (!convergence.mayContinue) break;
    }
    // Same split as the inner loop: a repeated failure set is the loop's own
    // stop, running out of rounds while it still moved is the budget's.
    const stoppedOnLoop = convergence !== null && !convergence.mayContinue;
    const stopRunId = this.createRunId(cardId, "VERIFY", round);
    const stopReason = stoppedOnLoop ? "verify_loop_exceeded" : "retry_limit_exceeded";
    await this.store.stopForInput(cardId, "REGRESSION_FIX", stopReason, stopRunId, {
      convergence: stoppedOnLoop ? convergence!.classification : "budget_exhausted",
      budget: this.maxInnerLoopRounds,
      failed: failureHistory.at(-1) ?? [],
    });
    await this.projection.enqueue(cardId);
    return { state: "NEEDS_INPUT", rounds: round, mrUrl: story.mrUrl, stopReason };
  }

  /** Runs the DESIGN phase and freezes its DoD. A persisted result frozen
   * before a contract fix would otherwise be reused forever; it is
   * invalidated once and regenerated from a fresh session. */
  /**
   * The narrow SPECIFY in front of a regression fix.
   *
   * The reproduction test is written, proved red on the tree as it stands and
   * frozen before the fix may touch the code it exists to prove. Without it a
   * delivered card could be "repaired" with nothing showing the break, which is
   * exactly the state the regression loop was opened to end.
   */
  private async regressionEntry(cardId: string, story: StorySnapshot): Promise<StoryWorkerResult> {
    const cards = (await this.store.buildPhaseInput(cardId, "REGRESSION_FIX", story.innerLoopRounds + 1)).regressions ?? [];
    let runId = this.createRunId(cardId, "SPECIFY", 1);
    if (cards.length > 0) {
      const full = await this.store.getDefinitionOfDone(cardId);
      const wanted = new Set(cards.map((card) => card.scenarioId));
      const narrowed: DefinitionOfDone = {
        ...full,
        scenarios: full.scenarios.filter((scenario) => wanted.has(scenario.id)),
      };
      const narrow = await this.specifyPhase(cardId, narrowed, "narrow");
      await this.projection.enqueue(cardId);
      runId = narrow.runId;
    }
    // With nothing left to fix the hop is still taken: the fix loop owns the
    // return to DELIVERED, and there is no edge that skips it.
    await this.store.transition(cardId, "SPECIFY", "REGRESSION_FIX", "system", runId);
    return this.regressionFixLoop(cardId, await this.store.getStory(cardId));
  }

  /**
   * SHAPE, then DESIGN, then SPECIFY, resumable at any of the three.
   *
   * They are three phases and not one because each holds something the others
   * must not touch. SHAPE owns the acceptance bar and is the only phase allowed
   * to ask a question; DESIGN reads that bar frozen and is forbidden to ask;
   * SPECIFY turns it into tests that fail before any implementation exists.
   * Collapsing them would put the phase that writes the acceptance bar in
   * charge of rewriting it when it is sent back, and would make a person's
   * answer cost a full redesign instead of the shortest phase on the card.
   */
  private async runFrontPhases(
    cardId: string,
    from: StoryState,
  ): Promise<{ definitionOfDone: DefinitionOfDone; stopped?: StoryWorkerResult }> {
    let state = from;
    if (state === "QUEUED") {
      await this.store.transition(cardId, "QUEUED", "SHAPE", "system", this.createRunId(cardId, "SHAPE", 1));
      state = "SHAPE";
    }
    if (state === "SHAPE") {
      const shaped = await this.shapePhase(cardId);
      await this.projection.enqueue(cardId);
      if (shaped.stopped) return { definitionOfDone: shaped.definitionOfDone, stopped: shaped.stopped };
      await this.store.transition(cardId, "SHAPE", "DESIGN", "system", shaped.runId);
      state = "DESIGN";
    }
    const definitionOfDone = await this.store.getDefinitionOfDone(cardId);
    if (state === "DESIGN") {
      const design = await this.runPhase(cardId, "DESIGN", 1, this.createRunId(cardId, "DESIGN", 1));
      artifact(design, "design-summary");
      // The frozen contract has to come out of DESIGN exactly as it went in.
      // DESIGN has write access to the worktree for its interface drafts, and
      // a phase that could edit the bar it is designing against would be
      // marking its own work.
      const afterDesign = await this.store.getDefinitionOfDone(cardId);
      if (JSON.stringify(afterDesign) !== JSON.stringify(definitionOfDone)) {
        throw new Error("DESIGN changed the frozen DoD; only a person sending the card back to SHAPE may change it");
      }
      await this.projection.enqueue(cardId);
      await this.store.transition(cardId, "DESIGN", "SPECIFY", "system", this.createRunId(cardId, "SPECIFY", 1));
      state = "SPECIFY";
    }
    if (state === "SPECIFY") {
      const specified = await this.specifyPhase(cardId, definitionOfDone);
      await this.projection.enqueue(cardId);
      await this.store.transition(cardId, "SPECIFY", "CODE", "system", specified.runId);
    }
    return { definitionOfDone: await this.store.getDefinitionOfDone(cardId) };
  }

  /**
   * Hardens the requirement into a contract that can be judged true or false,
   * and records whatever it could not settle on its own.
   *
   * A blocking question stops the card. A non-blocking one does not: it carries
   * a proposed answer, so the card goes on and a person can correct it later
   * through the rework channel, which is the only way the bar changes.
   */
  private async shapePhase(cardId: string): Promise<{
    definitionOfDone: DefinitionOfDone; runId: string; stopped?: StoryWorkerResult;
  }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const runId = this.createRunId(cardId, "SHAPE", 1);
      const gate = this.dodGate(cardId, runId);
      const shaped = await this.runPhase(cardId, "SHAPE", 1, runId, [gate]);
      const questions = JSON.parse(artifact(shaped, "open-questions")) as Array<{
        id: string; question: string; suggestion: string; blocking: boolean;
      }>;
      await this.store.recordOpenQuestions(cardId, questions);
      try {
        // A port that does not enforce the gate (a caller driving phases
        // directly) still has to be judged, once: what a person reads must not
        // depend on which port ran the phase. The refusal lands in the catch
        // below, which is the older and more expensive path -- a new session.
        if (shaped.exitGateRounds?.[gate.name] === undefined) {
          const verdict = await gate.evaluate(shaped.artifacts, 1);
          if (!verdict.passed) throw new DoDValidationError(verdict.findings);
        }
        const definitionOfDone = parseDoD(artifact(shaped, "dod"));
        const frozen = await this.store.findFrozenDefinitionOfDone(cardId);
        if (frozen) {
          await this.store.refreezeDefinitionOfDone(cardId, definitionOfDone);
        } else {
          await this.store.freezeDefinitionOfDone(cardId, definitionOfDone);
        }
        // A card with screens and no interface contract on the branch is the
        // failure design 08 exists to stop: it would invent a look of its own,
        // and the next card would invent a different one. Which contract the
        // repository gets is a requirement-level decision, so this is a
        // person's call rather than something SHAPE can rewrite its way out
        // of -- the findings loop above cannot put a token table in a tree.
        const screens = definitionOfDone.scenarios.filter((scenario) => hasScreen(scenario));
        if (screens.length > 0 && this.interfaceContract && (await this.interfaceContract()) === null) {
          const detail = renderMissingInterfaceContract(screens.map((scenario) => scenario.id));
          await this.friction?.record({ cardId, runId, kind: "interface_contract_missing", detail });
          await this.store.stopForInput(cardId, "SHAPE", "blocking_question", runId);
          return {
            definitionOfDone,
            runId,
            stopped: {
              state: "NEEDS_INPUT",
              rounds: 0,
              mrUrl: null,
              stopReason: "blocking_question",
              stopReport: detail,
            },
          };
        }
        const blocking = await this.store.unansweredBlockingQuestions(cardId);
        if (blocking.length > 0) {
          await this.store.stopForInput(cardId, "SHAPE", "blocking_question", runId);
          return {
            definitionOfDone,
            runId,
            stopped: {
              state: "NEEDS_INPUT",
              rounds: 0,
              mrUrl: null,
              stopReason: "blocking_question",
              stopReport: blocking.join("\n"),
            },
          };
        }
        return { definitionOfDone, runId };
      } catch (cause) {
        // A frozen contract is the Story's setpoint. Re-entering after a crash
        // between the freeze and the transition adopts it rather than spending
        // sessions failing to replace it and cascading its artifacts away.
        const existing = await this.store.findFrozenDefinitionOfDone(cardId);
        if (existing) return { definitionOfDone: existing, runId };
        if (attempt > 0) throw cause;
        await this.store.invalidateCompletedPhase(cardId, "SHAPE", 1, (cause as Error).message);
      }
    }
    throw new Error("SHAPE did not produce a valid DoD");
  }

  /**
   * The screens this card promises, opened on the application the repository
   * itself starts.
   *
   * A phase that wrote a page and never mounted it has green tests and a
   * missing feature, and every layer after this one is too late or looking at
   * the wrong server: VERIFY reads a browser, and until an application lane
   * existed that browser could be pointed at something the verifier had
   * assembled itself. Handed back inside the session that wrote the code, so
   * it costs no round -- mounting what you just built is a work item, not a
   * verdict on the Story.
   *
   * Counted, so the rule is judged on evidence rather than on how reasonable
   * it sounds: a gate that never fires says the prompt was already enough.
   */
  private screenGate(cardId: string, runId: string): PhaseExitGate | null {
    const reachable = this.screensReachable;
    if (!reachable) return null;
    return {
      name: "screen-reachable",
      maxRounds: 2,
      exhausted: "fail",
      evaluate: async () => {
        const definitionOfDone = await this.store.getDefinitionOfDone(cardId);
        const pages = screenPages(definitionOfDone);
        if (pages.length === 0) return { passed: true };
        const unreachable = await reachable(pages);
        // No application to ask: this repository declares no way to start one,
        // and a screen no entry point can be asked about is the browser's
        // question again, not this gate's.
        if (unreachable === null || unreachable.length === 0) return { passed: true };
        await this.friction?.record({
          cardId,
          runId,
          kind: "screen_not_mounted",
          detail: unreachable.map((entry) => `${entry.scenarioId} ${entry.page}`).join(", "),
        });
        return { passed: false, findings: renderUnreachableScreens(unreachable) };
      },
    };
  }

  /**
   * The contract a person judges the card by: it has to parse, and it has to
   * be written in their language.
   *
   * Both go back to the session that wrote it. A DoD in English, or one whose
   * YAML does not hold together, is a work item that session can fix in one
   * turn; refusing it into a new run pays for a whole phase to change a
   * sentence, and the abandoned run reads downstream as a crash.
   */
  private dodGate(cardId: string, runId: string): PhaseExitGate {
    return {
      name: "dod",
      maxRounds: 3,
      exhausted: "fail",
      evaluate: async (artifacts) => {
        const body = artifacts.find((item) => item.kind === "dod")?.body ?? "";
        let definitionOfDone: DefinitionOfDone;
        try {
          definitionOfDone = parseDoD(body);
        } catch (cause) {
          return { passed: false, findings: (cause as Error).message };
        }
        // The screen judgements' basis, asked for here because a judgement's
        // basis cannot be written by the round it judges (08 section 6). Both
        // in one pass: a DoD missing each would otherwise spend two of the
        // three rounds saying two halves of the same sentence.
        const missingVisible = scenariosMissingVisible(definitionOfDone);
        const missingPage = scenariosMissingPage(definitionOfDone);
        if (missingVisible.length > 0 || missingPage.length > 0) {
          return {
            passed: false,
            findings: [
              ...(missingPage.length > 0 ? [renderMissingPage(missingPage)] : []),
              ...(missingVisible.length > 0 ? [renderMissingVisible(missingVisible)] : []),
            ].join("\n\n"),
          };
        }
        // Before the language, because a footprint that names nothing is a
        // fact about the tree rather than about the sentence, and the session
        // should not be asked to rewrite prose in the same turn it is asked to
        // look at directories.
        const repositoryHas = this.repositoryHas;
        if (repositoryHas) {
          const ungrounded = footprintWithoutGround(definitionOfDone, repositoryHas);
          if (ungrounded.length > 0) {
            await this.friction?.record({
              cardId,
              runId,
              kind: "footprint_without_ground",
              detail: ungrounded.join(", "),
            });
            return { passed: false, findings: renderFootprintWithoutGround(ungrounded) };
          }
        }
        const language = lintDoDLanguage(definitionOfDone);
        if (language.length === 0) return { passed: true };
        // Counted so the rule is judged on evidence: a gate that never fires
        // says the prompt is already enough, and one that fires every card
        // says the prompt is not the layer to fix it in.
        await this.friction?.record({
          cardId,
          runId,
          kind: "dod_language_rejected",
          detail: language.map((finding) => `${finding.where} ${finding.what}`).join("; "),
        });
        return { passed: false, findings: renderDoDLanguageFindings(language) };
      },
    };
  }

  /**
   * Writes the tests, proves they fail on the tree being frozen, and commits.
   *
   * The exit findings go back to the same live session, like the CODE exit's:
   * they are a work item, not a verdict on the Story, so they cost no round.
   */
  private async specifyPhase(
    cardId: string,
    dod: DefinitionOfDone,
    expectedMode: "full" | "narrow" = "full",
  ): Promise<{ runId: string }> {
    const gate = this.specifyGate;
    const attempt = (await this.store.testContractAttempts(cardId)) + 1;
    const runId = this.createRunId(cardId, "SPECIFY", attempt);
    // Frozen before the phase runs, not after: the gate re-measures the tree
    // on every handback, and a base that moved under it would compare two
    // different questions. A card re-entered by hand, or a delivered card
    // running a narrow regression pass, has legitimate implementation in its
    // tree, so this is entry and not the DESIGN commit (03 section 12.2).
    const baseCommit = gate ? await gate.baseCommit() : "";
    let settled: { contract: TestContract; frozen: { commit: string; treeSha: string } } | undefined;
    // Findings go back to the same SPECIFY session. A contract in the wrong
    // mode, or tests that do not fail for the reason they claim, is a work
    // item the session that wrote it can fix in one turn; refusing it into a
    // new run cost S-AGENTRULES-01 two phase runs and then the card.
    const exitGate: PhaseExitGate = {
      name: "specify-exit",
      exhausted: "fail",
      maxRounds: this.specifyExitRounds,
      evaluate: async (artifacts) => {
        const contractYaml = artifacts.find((item) => item.kind === "test-contract")?.body;
        if (contractYaml === undefined) {
          return { passed: false, findings: "This phase produced no test contract. Write one." };
        }
        let contract: TestContract;
        try {
          contract = parseTestContract(contractYaml);
        } catch (cause) {
          // A contract that does not parse is a work item, not a verdict on
          // the Story. Thrown, it escaped the gate entirely: out of the phase,
          // out of the process, and back to the coordinator as an unknown
          // crash that also spent a phase re-entry -- for a model that wrote
          // one key the schema does not have and could have dropped it in one
          // turn. S-R237511DT-03 and -04 each lost a run that way.
          if (!(cause instanceof TestContractValidationError)) throw cause;
          // Counted so the next reading of this rule has numbers: a contract
          // the schema keeps refusing is either a prompt that does not say
          // what the shape is or a schema that is stricter than it needs.
          await this.friction?.record({
            cardId, runId, kind: "specify_contract_unparsable", detail: cause.message,
          });
          return {
            passed: false,
            findings: `${cause.message}\nRewrite the contract with only the keys the schema defines.`,
          };
        }
        if (contract.mode !== expectedMode) {
          // A narrow rerun that writes a full contract would put every
          // scenario of a delivered card back under proof, and a full one
          // that writes narrow would leave most of the card unproven.
          return {
            passed: false,
            findings: `The contract must be ${expectedMode}, not ${contract.mode}. Rewrite it in ${expectedMode} mode.`,
          };
        }
        await this.store.beginTestContract({
          cardId, attempt, mode: contract.mode, contractYaml,
          specifyBaseCommit: baseCommit, testPaths: gate ? gate.testPathPatterns() : [],
        });
        if (!gate) {
          // No repository to measure against. The contract is recorded so a
          // caller without a worktree can drive the phase; nothing is proved.
          return { passed: true };
        }
        const verdict = await evaluateSpecExit({
          cardId,
          contract,
          dod,
          baseCommit,
          testPathPatterns: gate.testPathPatterns(),
          ports: gate.ports(cardId),
        });
        if (!verdict.passed || !verdict.frozen) {
          return { passed: false, findings: renderSpecExitFindings(verdict) };
        }
        settled = { contract, frozen: verdict.frozen };
        return { passed: true };
      },
    };

    const result = await this.runPhase(cardId, "SPECIFY", attempt, runId, [exitGate]);
    if (settled === undefined) {
      // A port that does not enforce the gate (a caller driving phases
      // directly) still has to be judged, once, on what it produced.
      const verdict = await exitGate.evaluate(result.artifacts, 1);
      if (!verdict.passed) {
        await this.store.invalidateCompletedPhase(cardId, "SPECIFY", attempt, verdict.findings);
        await this.friction?.record({
          cardId, runId, kind: "specify_exit_rejected", detail: verdict.findings,
        });
        throw new Error(verdict.findings);
      }
    }
    if (!settled) return { runId };
    await this.store.freezeTestContract(cardId, attempt, settled.frozen.commit, settled.frozen.treeSha);
    // A scenario this phase could not settle is handed to VERIFY explicitly, so
    // the contract it will be judged by says who proves it.
    const downgraded = applyDowngrades(dod, settled.contract);
    if (JSON.stringify(downgraded) !== JSON.stringify(dod)) {
      await this.store.refreezeDefinitionOfDone(cardId, downgraded);
    }
    return { runId };
  }

  /**
   * The system precondition on the VERIFY -> MERGE edge: every declared
   * scenario has a passing conclusion at its current contract wording, on the
   * tree about to be merged.
   *
   * A scenario nothing touched is carried forward rather than re-run, but only
   * when both its wording and the tree are unchanged. An unchanged wording is
   * not enough on its own: the fix another scenario needed may have changed
   * code the two of them share.
   */
  private async settleScenarios(cardId: string, round: number): Promise<string[]> {
    if (!this.treeSha) return [];
    const treeSha = await this.treeSha();
    if (treeSha === "") return [];
    await this.store.carryForwardScenarios({ cardId, round, treeSha });
    const settled = await this.store.scenariosSettled(cardId, treeSha);
    return [...settled.outstanding];
  }

  /** Adds the screens the requirement was approved with. The prompt itself
   * reads no files: the contract is data by the time it reaches the assembly,
   * which is what keeps an identical input producing identical bytes. */
  private async withInterfaceContract(context: PhaseInput): Promise<PhaseInput> {
    if (!this.interfaceContract) return context;
    const contract = await this.interfaceContract();
    return contract ? { ...context, interfaceContract: contract } : context;
  }

  async runPhase(
    cardId: string,
    phase: Exclude<StoryPhase, "VERIFY">,
    round: number,
    runId: string,
    exitGates?: readonly PhaseExitGate[],
  ): Promise<ManagedPhaseResult> {
    const persisted = await this.store.getCompletedPhase(cardId, phase, round);
    if (persisted) return persisted;
    const context = await this.withInterfaceContract(await this.store.buildPhaseInput(cardId, phase, round));
    const prompt = assemblePhasePrompt(context);
    // The attempt number comes from the store, not from a counter in this
    // process: a re-entry after a crash is a new attempt on the same slot, and
    // it has to land in a session file of its own.
    const { attempt } = await this.store.beginPhase({ runId, cardId, phase, round, prompt });
    try {
      const result = await this.phases.run({
        runId, phase, round, prompt, context, attempt,
        ...(exitGates && exitGates.length > 0 ? { exitGates } : {}),
      });
      await this.store.completePhase({
        runId,
        sessionId: result.sessionId,
        artifacts: result.artifacts,
      });
      return result;
    } catch (cause) {
      await this.store.failPhase(runId, cause instanceof Error ? cause.message : "phase failed");
      throw cause;
    }
  }

  async runVerification(
    cardId: string,
    round: number,
    runId: string,
    codeSessionId: string,
    definitionOfDone: DefinitionOfDone,
  ): Promise<ManagedVerifyResult> {
    const context = await this.withInterfaceContract(await this.store.buildPhaseInput(cardId, "VERIFY", round));
    const prompt = assemblePhasePrompt(context);
    const { attempt } = await this.store.beginPhase({ runId, cardId, phase: "VERIFY", round, prompt });
    try {
      const result = await this.verifier.run({
        runId,
        attempt,
        round,
        prompt,
        context,
        codeSessionId,
        definitionOfDone,
      });
      // Read before anything is committed: this reaches into the worktree, and
      // a worktree that is gone answers with a failure. Completing the run
      // first would have made that failure permanent, because a completed run
      // is reused rather than started again and this round's slot would hold
      // one that never reached a verdict.
      const treeSha = this.treeSha ? await this.treeSha() : "";
      await this.store.completeVerification({
        runId,
        sessionId: result.sessionId,
        artifacts: [{ kind: "verification", body: result.artifact }],
        record: {
          cardId,
          round,
          codeSessionId,
          verifySessionId: result.sessionId,
          verdict: result.verdict,
          failedScenarios: result.failedScenarios,
          // Only what this round actually looked at. A narrow round that judged
          // one scenario must not mark the rest of the card passed by default.
          verifiedScenarios: definitionOfDone.scenarios.map((scenario) => scenario.id),
          ...(treeSha === "" ? {} : { verifiedTreeSha: treeSha }),
          ...(result.evidenceDir ? { evidenceDir: result.evidenceDir } : {}),
          ...(result.screenshots ? { screenshots: result.screenshots } : {}),
        },
      });
      return result;
    } catch (cause) {
      await this.store.failPhase(runId, cause instanceof Error ? cause.message : "verification failed")
        .catch(() => undefined);
      throw cause;
    }
  }
}
