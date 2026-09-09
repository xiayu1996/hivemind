import { randomUUID } from "node:crypto";
import { classifyConvergence } from "../pipeline/convergence.js";
import { parseDoD, type DefinitionOfDone } from "../pipeline/dod.js";
import { assemblePhasePrompt, type PhaseInput } from "../pipeline/phase-input.js";
import {
  StoryExecutionStore,
  type StoryPhase,
  type StorySnapshot,
} from "./story-execution-store.js";

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
  /** Puts the Story on its Epic head. A result other than "merged" has already
   * returned the Story to CODE; the run stops without delivering. */
  integrate(cardId: string, runId: string): Promise<{ kind: string; reason?: string }>;
}

export interface StoryWorkerOptions {
  maxInnerLoopRounds?: number;
  /** How many consecutive rounds may be lost to the environment before the
   * card stops for a person. The rounds themselves cost no budget; this is
   * what keeps a broken host from looping forever. */
  maxInconclusiveRounds?: number;
  integration?: StoryIntegrationPort;
  friction?: StoryFrictionPort;
  runId?: (cardId: string, phase: StoryPhase, round: number) => string;
}

export interface StoryWorkerResult {
  state: "DELIVERED" | "NEEDS_INPUT" | "CODE";
  rounds: number;
  mrUrl: string | null;
  stopReason: "verify_loop_exceeded" | null;
}

function artifact(result: ManagedPhaseResult, kind: string): string {
  const found = result.artifacts.find((item) => item.kind === kind);
  if (!found) throw new Error(`phase result is missing required artifact: ${kind}`);
  return found.body;
}

/** Executes one Story on one host through DESIGN, CODE/VERIFY and MERGE. */
export class SingleStoryWorker {
  private readonly maxInnerLoopRounds: number;
  private readonly maxInconclusiveRounds: number;
  private readonly friction: StoryFrictionPort | undefined;
  private readonly createRunId: (cardId: string, phase: StoryPhase, round: number) => string;
  private readonly integration: StoryIntegrationPort | undefined;

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
    this.maxInconclusiveRounds = options.maxInconclusiveRounds ?? 2;
    this.maxInnerLoopRounds = options.maxInnerLoopRounds ?? 6;
    if (!Number.isInteger(this.maxInnerLoopRounds) || this.maxInnerLoopRounds < 1) {
      throw new Error("maxInnerLoopRounds must be a positive integer");
    }
    this.createRunId = options.runId ?? ((cardId, phase, round) => {
      const safeCardId = cardId.replaceAll(/[^A-Za-z0-9._-]/g, "-");
      return `${safeCardId}-${phase.toLowerCase()}-${round}-${randomUUID()}`;
    });
  }

  async run(cardId: string): Promise<StoryWorkerResult> {
    let story = await this.store.getStory(cardId);
    let definitionOfDone: DefinitionOfDone;
    // VERIFY already accepted: re-entering at MERGE skips the inner loop and
    // redoes only the delivery report plus branch publication.
    const mergeOnly = story.state === "MERGE";
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
        round += 1;
        const codeRunId = this.createRunId(cardId, "CODE", round);
        const code = await this.runPhase(cardId, "CODE", round, codeRunId);
        artifact(code, "implementation");
        const verifyRunId = this.createRunId(cardId, "VERIFY", round);
        await this.store.transition(cardId, "CODE", "VERIFY", "system", verifyRunId);
        const verification = await this.runVerification(
          cardId,
          round,
          verifyRunId,
          code.sessionId,
          definitionOfDone,
        );
        await this.projection.enqueue(cardId);

        if (verification.verdict === "accepted" && verification.failedScenarios.length === 0) {
          mergeRunId = this.createRunId(cardId, "MERGE", 1);
          totalRounds = round;
          await this.store.transition(cardId, "VERIFY", "MERGE", "system", mergeRunId);
          break;
        }

        if (verification.verdict === "inconclusive") {
          // The round was lost to the environment, not to the code: it says
          // nothing about convergence, so it costs no budget. Two in a row is
          // the pipeline's own failure and belongs to a person.
          inconclusiveStreak += 1;
          if (inconclusiveStreak >= this.maxInconclusiveRounds) {
            await this.friction?.record({
              cardId,
              runId: verifyRunId,
              kind: "verification_inconclusive",
              detail: `${inconclusiveStreak} consecutive rounds failed for environmental reasons: ${verification.failedScenarios.join(", ")}`,
            });
            await this.store.stopForInput(cardId, "VERIFY", "verify_loop_exceeded", verifyRunId);
            await this.projection.enqueue(cardId);
            return { state: "NEEDS_INPUT", rounds: round, mrUrl: null, stopReason: "verify_loop_exceeded" };
          }
          await this.store.transition(cardId, "VERIFY", "CODE", "system", verifyRunId);
          continue;
        }
        inconclusiveStreak = 0;
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
    if (this.integration && story.epicId) {
      // A Story inside an Epic is delivered by landing on the Epic head, not by
      // publishing its own branch. Anything but a clean merge is the Story's
      // problem and it has already been sent back to CODE.
      const integrated = await this.integration.integrate(cardId, mergeRunId);
      if (integrated.kind !== "merged") {
        await this.projection.enqueue(cardId);
        return { state: "CODE", rounds: totalRounds, mrUrl: null, stopReason: null };
      }
    }
    const delivered = await this.delivery.deliver({ story, mergeArtifact });
    await this.store.markDelivered(cardId, mergeRunId, delivered.mrUrl);
    await this.projection.enqueue(cardId);
    return {
      state: "DELIVERED",
      rounds: totalRounds,
      mrUrl: delivered.mrUrl,
      stopReason: null,
    };
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
