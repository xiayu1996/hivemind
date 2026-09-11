import { randomUUID } from "node:crypto";
import { classifyConvergence } from "../pipeline/convergence.js";
import { costCeilingVerdict, renderCostCeilingReport, type CardSpend } from "../pipeline/cost-ceiling.js";
import { DoDValidationError, parseDoD, type DefinitionOfDone } from "../pipeline/dod.js";
import { assemblePhasePrompt, type PhaseInput } from "../pipeline/phase-input.js";
import {
  StoryExecutionStore,
  type StoryPhase,
  type StorySnapshot,
} from "./story-execution-store.js";
import type { StoryState } from "./state-machine.js";

export interface ManagedPhaseInput {
  runId: string;
  phase: Exclude<StoryPhase, "VERIFY">;
  round: number;
  prompt: string;
  context: PhaseInput;
}

export interface ManagedPhaseResult {
  sessionId: string;
  artifacts: Array<{ kind: string; body: string }>;
}

export interface StoryPhasePort {
  run(input: ManagedPhaseInput): Promise<ManagedPhaseResult>;
}

export interface ManagedVerifyInput {
  runId: string;
  round: number;
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
  ): Promise<{ kind: string; reason?: string; mrUrl?: string | null }>;
}

export interface StoryWorkerOptions {
  maxInnerLoopRounds?: number;
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

export interface StoryWorkerResult {
  state: "DELIVERED" | "NEEDS_INPUT" | "CODE";
  rounds: number;
  mrUrl: string | null;
  stopReason: "verify_loop_exceeded" | "retry_limit_exceeded" | "cost_ceiling_exceeded" | null;
  /** Attached to the card when the run stopped; business language, no thresholds alone. */
  stopReport?: string;
}

function artifact(result: ManagedPhaseResult, kind: string): string {
  const found = result.artifacts.find((item) => item.kind === kind);
  if (!found) throw new Error(`phase result is missing required artifact: ${kind}`);
  return found.body;
}

/** Executes one Story on one host through DESIGN, CODE/VERIFY and MERGE. */
export class SingleStoryWorker {
  private readonly maxInnerLoopRounds: number;
  private readonly maxRegressionReopens: number;
  private readonly maxInconclusiveRounds: number;
  private readonly friction: StoryFrictionPort | undefined;
  private readonly createRunId: (cardId: string, phase: StoryPhase, round: number) => string;
  private readonly integration: StoryIntegrationPort | undefined;
  private readonly spend: StorySpendPort | undefined;

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
    this.maxInconclusiveRounds = options.maxInconclusiveRounds ?? 2;
    this.maxInnerLoopRounds = options.maxInnerLoopRounds ?? 6;
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
      // longer accepts cannot drive VERIFY, so the Story is designed again
      // rather than failing every attempt until a person notices.
      try {
        await this.store.getDefinitionOfDone(cardId);
      } catch (cause) {
        if (!(cause instanceof DoDValidationError)) throw cause;
        const redesignRunId = this.createRunId(cardId, "DESIGN", 1);
        await this.store.resetForRedesign(cardId, cause.message);
        await this.store.transition(cardId, story.state, "DESIGN", "system", redesignRunId);
        await this.friction?.record({ cardId, runId: redesignRunId, kind: "dod_contract_changed", detail: cause.message });
        story = await this.store.getStory(cardId);
        mergeOnly = false;
      }
    }
    if (mergeOnly) {
      definitionOfDone = await this.store.getDefinitionOfDone(cardId);
    } else if (story.state === "QUEUED" || story.state === "DESIGN") {
      // QUEUED starts the pipeline; a story left in DESIGN re-enters the
      // phase after a mid-phase failure. The reentry budget is enforced by
      // the dispatcher that decides to re-run this card at all.
      if (story.state === "QUEUED") {
        const startRunId = this.createRunId(cardId, "DESIGN", 1);
        await this.store.transition(cardId, "QUEUED", "DESIGN", "system", startRunId);
      }
      const design = await this.designPhase(cardId);
      definitionOfDone = design.definitionOfDone;
      await this.projection.enqueue(cardId);
      await this.store.transition(cardId, "DESIGN", "CODE", "system", design.runId);
    } else if (story.state === "CODE") {
      definitionOfDone = await this.store.getDefinitionOfDone(cardId);
    } else {
      throw new Error(`Story ${cardId} must be QUEUED, DESIGN, CODE or MERGE, not ${story.state}`);
    }

    let mergeRunId = "";
    let totalRounds = mergeOnly ? story.innerLoopRounds : 0;
    if (!mergeOnly) {
      // The budget counts the rounds since a person last acted on the card: a
      // resume is a decision to spend more, not a replay of the spent rounds.
      const failureHistory = await this.store.getVerificationFailureHistory(cardId, story.lastHumanActionAt ?? 0);
      // Round numbers keep counting across resumes; the budget does not.
      let round = story.innerLoopRounds;
      if (failureHistory.length >= this.maxInnerLoopRounds) {
        // The Epic head refused the branch after the loop was already spent:
        // there is no round left to fix it in, so this is the verification stop.
        const stopRunId = this.createRunId(cardId, "VERIFY", round);
        await this.store.stopForInput(cardId, story.state, "verify_loop_exceeded", stopRunId);
        await this.projection.enqueue(cardId);
        return { state: "NEEDS_INPUT", rounds: round, mrUrl: null, stopReason: "verify_loop_exceeded" };
      }
      // `spent` is the budget: only a round that failed in the code costs one.
      let spent = failureHistory.length;
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
        const code = await this.runPhase(cardId, "CODE", round, codeRunId);
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
            await this.store.stopForInput(cardId, "VERIFY", "retry_limit_exceeded", verifyRunId);
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
          mergeRunId = this.createRunId(cardId, "MERGE", 1);
          totalRounds = round;
          await this.store.transition(cardId, "VERIFY", "MERGE", "system", mergeRunId);
          break;
        }

        spent += 1;
        failureHistory.push([
          ...new Set(verification.codeFailedScenarios ?? verification.failedScenarios),
        ].toSorted());
        const convergence = classifyConvergence(failureHistory);
        if (spent >= this.maxInnerLoopRounds || !convergence.mayContinue) {
          await this.store.stopForInput(cardId, "VERIFY", "verify_loop_exceeded", verifyRunId);
          await this.projection.enqueue(cardId);
          return {
            state: "NEEDS_INPUT",
            rounds: round,
            mrUrl: null,
            stopReason: "verify_loop_exceeded",
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
      // fix would never leave.
      const runId = this.createRunId(cardId, "REGRESSION_FIX", story.innerLoopRounds);
      await this.store.transition(cardId, "REGRESSION_FIX", "DELIVERED", "system", runId);
      await this.projection.enqueue(cardId);
      return { state: "DELIVERED", rounds: story.innerLoopRounds, mrUrl: story.mrUrl, stopReason: null };
    }
    if (!this.integration || !story.epicId) {
      throw new Error(`Story ${cardId} cannot land a regression fix without its Epic integration`);
    }
    if (story.regressionReopens >= this.maxRegressionReopens) {
      const runId = this.createRunId(cardId, "REGRESSION_FIX", story.innerLoopRounds);
      await this.store.stopForInput(cardId, "REGRESSION_FIX", "retry_limit_exceeded", runId);
      await this.projection.enqueue(cardId);
      return {
        state: "NEEDS_INPUT",
        rounds: story.innerLoopRounds,
        mrUrl: story.mrUrl,
        stopReason: null,
        stopReport: `${cardId} stopped: retry.maxRegressionReopens

The regression loop reopened this Story ${story.regressionReopens} times; the cards still open: ${cards.map((card) => card.scenarioId).join(", ")}
`,
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
    for (let spent = 0; spent < this.maxInnerLoopRounds;) {
      const overspent = await this.#costCeilingStop(cardId, "REGRESSION_FIX", round);
      if (overspent) return overspent;
      round += 1;
      const fixRunId = this.createRunId(cardId, "REGRESSION_FIX", round);
      const fix = await this.runPhase(cardId, "REGRESSION_FIX", round, fixRunId);
      artifact(fix, "implementation");
      const verifyRunId = this.createRunId(cardId, "VERIFY", round);
      const verification = await this.runVerification(cardId, round, verifyRunId, fix.sessionId, definitionOfDone);
      await this.projection.enqueue(cardId);

      if (verification.verdict === "inconclusive") {
        inconclusiveStreak += 1;
        if (inconclusiveStreak >= this.maxInconclusiveRounds) {
          await this.store.stopForInput(cardId, "REGRESSION_FIX", "verify_loop_exceeded", verifyRunId);
          await this.projection.enqueue(cardId);
          return { state: "NEEDS_INPUT", rounds: round, mrUrl: story.mrUrl, stopReason: "verify_loop_exceeded" };
        }
        continue;
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
      if (!classifyConvergence(failureHistory).mayContinue) break;
    }
    const stopRunId = this.createRunId(cardId, "VERIFY", round);
    await this.store.stopForInput(cardId, "REGRESSION_FIX", "verify_loop_exceeded", stopRunId);
    await this.projection.enqueue(cardId);
    return { state: "NEEDS_INPUT", rounds: round, mrUrl: story.mrUrl, stopReason: "verify_loop_exceeded" };
  }

  /** Runs the DESIGN phase and freezes its DoD. A persisted result frozen
   * before a contract fix would otherwise be reused forever; it is
   * invalidated once and regenerated from a fresh session. */
  private async designPhase(cardId: string): Promise<{ definitionOfDone: DefinitionOfDone; runId: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const runId = this.createRunId(cardId, "DESIGN", 1);
      const design = await this.runPhase(cardId, "DESIGN", 1, runId);
      artifact(design, "design-summary");
      try {
        const definitionOfDone = parseDoD(artifact(design, "dod"));
        await this.store.freezeDefinitionOfDone(cardId, definitionOfDone);
        return { definitionOfDone, runId };
      } catch (cause) {
        // A frozen DoD is the Story's setpoint. Re-entering DESIGN after a
        // crash between the freeze and the transition must adopt it, not spend
        // sessions failing to replace it and cascade its artifacts away.
        const frozen = await this.store.findFrozenDefinitionOfDone(cardId);
        if (frozen) return { definitionOfDone: frozen, runId };
        if (attempt > 0) throw cause;
        await this.store.invalidateCompletedPhase(cardId, "DESIGN", 1, (cause as Error).message);
      }
    }
    throw new Error("DESIGN did not produce a valid DoD");
  }

  async runPhase(
    cardId: string,
    phase: Exclude<StoryPhase, "VERIFY">,
    round: number,
    runId: string,
  ): Promise<ManagedPhaseResult> {
    const persisted = await this.store.getCompletedPhase(cardId, phase, round);
    if (persisted) return persisted;
    const context = await this.store.buildPhaseInput(cardId, phase, round);
    const prompt = assemblePhasePrompt(context);
    await this.store.beginPhase({ runId, cardId, phase, round, prompt });
    try {
      const result = await this.phases.run({ runId, phase, round, prompt, context });
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
    const context = await this.store.buildPhaseInput(cardId, "VERIFY", round);
    const prompt = assemblePhasePrompt(context);
    await this.store.beginPhase({ runId, cardId, phase: "VERIFY", round, prompt });
    try {
      const result = await this.verifier.run({
        runId,
        round,
        prompt,
        context,
        codeSessionId,
        definitionOfDone,
      });
      await this.store.completePhase({
        runId,
        sessionId: result.sessionId,
        artifacts: [{ kind: "verification", body: result.artifact }],
      });
      await this.store.recordVerification(runId, {
        cardId,
        round,
        codeSessionId,
        verifySessionId: result.sessionId,
        verdict: result.verdict,
        failedScenarios: result.failedScenarios,
        ...(result.evidenceDir ? { evidenceDir: result.evidenceDir } : {}),
        ...(result.screenshots ? { screenshots: result.screenshots } : {}),
      });
      return result;
    } catch (cause) {
      await this.store.failPhase(runId, cause instanceof Error ? cause.message : "verification failed")
        .catch(() => undefined);
      throw cause;
    }
  }
}
