import type { ClarifyRound, RequirementPagePublisher } from "./clarify-loop.js";
import { evaluatePrd, type PrdCandidate } from "./requirement-artifacts.js";
import { draftUntilUsable, requirementRunId as runId, stopOnUnusableDraft } from "./requirement-draft.js";
import type { RequirementStore } from "./requirement-store.js";

export interface PrdRequest {
  requirementId: string;
  title: string;
  originalRequest: string;
  history: readonly ClarifyRound[];
  /** What the person asked to change about earlier drafts, oldest first. */
  revisionFeedback: readonly string[];
  /** Why the last attempt was refused by the contract, not by a person. */
  previousRejections: readonly string[];
}

export interface PrdPort {
  run(input: PrdRequest): Promise<PrdCandidate>;
}

export type PrdOutcome =
  | { kind: "drafted"; revision: number }
  | { kind: "awaiting"; revision: number }
  | { kind: "confirmed"; revision: number }
  | { kind: "stopped"; reason: string };

/**
 * Writes the PRD and then gets out of the way. Approval is a person's act:
 * nothing here advances the requirement on its own, and a confirmed PRD is
 * never rewritten, so what was approved is what gets built.
 */
export class PrdRunner {
  constructor(
    private readonly store: RequirementStore,
    private readonly port: PrdPort,
    private readonly publisher: RequirementPagePublisher,
    private readonly attempts = 2,
  ) {}

  async advance(requirementId: string): Promise<PrdOutcome> {
    const requirement = await this.store.getRequirement(requirementId);
    if (requirement.state !== "PRD_CONFIRM") {
      throw new Error(`requirement ${requirementId} is ${requirement.state}, not waiting on a PRD`);
    }
    if (requirement.stopReason) return { kind: "stopped", reason: requirement.stopReason };

    const current = await this.store.getPrd(requirementId);
    if (current?.status === "confirmed") {
      // An approved PRD says what to build; what to build it with is decided
      // next, once for every card that follows (design 08).
      await this.store.transition(requirementId, "PRD_CONFIRM", "SOLUTION", "system", runId(requirementId));
      await this.publisher.publish(requirementId);
      return { kind: "confirmed", revision: current.revision };
    }
    if (current?.status === "draft") return { kind: "awaiting", revision: current.revision };

    const history = await this.store.clarifyHistory(requirementId);
    const revisionFeedback = await this.store.prdRevisionFeedback(requirementId);
    const drafted = await draftUntilUsable({
      attempts: this.attempts,
      run: async (previousRejections) => {
        const candidate = await this.port.run({
          requirementId,
          title: requirement.title,
          originalRequest: requirement.originalRequest,
          history,
          revisionFeedback,
          previousRejections,
        });
        const evaluated = evaluatePrd(requirementId, candidate);
        return evaluated.kind === "accepted"
          ? {
            kind: "accepted",
            value: {
              businessGoal: evaluated.businessGoal,
              nonGoals: evaluated.nonGoals,
              scenarios: evaluated.scenarios,
              openQuestions: evaluated.openQuestions,
            },
          }
          : { kind: "rejected", reasons: evaluated.reasons };
      },
    });
    if (drafted.kind === "unusable") {
      return {
        kind: "stopped",
        reason: await stopOnUnusableDraft({
          store: this.store, publisher: this.publisher, requirementId,
          state: "PRD_CONFIRM", what: "PRD", reasons: drafted.reasons,
        }),
      };
    }

    const revision = await this.store.saveDraftPrd(
      requirementId,
      JSON.stringify(drafted.value),
      runId(requirementId),
    );
    await this.publisher.publish(requirementId);
    return { kind: "drafted", revision };
  }
}
