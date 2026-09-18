import type { RequirementPagePublisher } from "./clarify-loop.js";
import type { PrdScenario } from "./requirement-artifacts.js";
import {
  approvalReasons,
  evaluateSolution,
  solutionNeedsApproval,
  type SolutionBody,
  type SolutionCandidate,
} from "./requirement-solution.js";
import { draftUntilUsable, requirementRunId as runId, stopOnUnusableDraft } from "./requirement-draft.js";
import type { RequirementStore } from "./requirement-store.js";

export interface SolutionRequest {
  requirementId: string;
  title: string;
  /** Which repository this is for: the stack it may keep or change is that
   * repository's, and a solution written against the wrong one is unusable. */
  repository: string;
  businessGoal: string;
  nonGoals: readonly string[];
  scenarios: readonly PrdScenario[];
  /** What the person asked to change about earlier drafts, oldest first. */
  revisionFeedback: readonly string[];
  /** Why the last attempt was refused by the contract, not by a person. */
  previousRejections: readonly string[];
}

export interface SolutionPort {
  run(input: SolutionRequest): Promise<SolutionCandidate>;
}

export type SolutionOutcome =
  | { kind: "drafted"; revision: number; awaiting: readonly string[] }
  | { kind: "awaiting"; revision: number }
  | { kind: "confirmed"; revision: number; source: "auto" | "human" }
  | { kind: "stopped"; reason: string };

/**
 * Decides what a requirement will be built with, once, before it is split into
 * Epics. Nothing below this has the scope: the PRD and the decomposition are
 * held to business language, and a Story's DESIGN may not ask questions and
 * sees a single card (design 08 section 1).
 *
 * Whether a person has to read it is decided from the solution's own body, not
 * from the agent's opinion of itself. A requirement that keeps the stack, asks
 * nothing and touches no screen carries no decision worth a person's time, and
 * stopping it would spend the one resource this whole layer exists to protect.
 */
export class SolutionRunner {
  constructor(
    private readonly store: RequirementStore,
    private readonly port: SolutionPort,
    private readonly publisher: RequirementPagePublisher,
    private readonly attempts = 2,
  ) {}

  async advance(requirementId: string): Promise<SolutionOutcome> {
    const requirement = await this.store.getRequirement(requirementId);
    if (requirement.state !== "SOLUTION") {
      throw new Error(`requirement ${requirementId} is ${requirement.state}, not choosing a solution`);
    }
    if (requirement.stopReason) return { kind: "stopped", reason: requirement.stopReason };

    const current = await this.store.getSolution(requirementId);
    if (current?.status === "confirmed") {
      await this.store.transition(requirementId, "SOLUTION", "DECOMPOSING", "system", runId(requirementId));
      await this.publisher.publish(requirementId);
      return { kind: "confirmed", revision: current.revision, source: "human" };
    }
    if (current?.status === "draft") return { kind: "awaiting", revision: current.revision };

    const prd = await this.store.getPrd(requirementId);
    if (!prd || prd.status !== "confirmed") {
      throw new Error(`requirement ${requirementId} has no confirmed PRD to build a solution on`);
    }
    const body = JSON.parse(prd.body) as { businessGoal: string; nonGoals: string[]; scenarios: PrdScenario[] };
    const revisionFeedback = await this.store.solutionRevisionFeedback(requirementId);
    const drafted = await draftUntilUsable<SolutionBody>({
      attempts: this.attempts,
      run: async (previousRejections) => {
        const candidate = await this.port.run({
          requirementId,
          title: requirement.title,
          repository: requirement.repo ?? "",
          businessGoal: body.businessGoal,
          nonGoals: body.nonGoals,
          scenarios: body.scenarios,
          revisionFeedback,
          previousRejections,
        });
        const evaluated = evaluateSolution(candidate);
        return evaluated.kind === "accepted"
          ? {
            kind: "accepted",
            value: {
              approach: evaluated.approach,
              stackChanges: evaluated.stackChanges,
              openDecisions: evaluated.openDecisions,
              qualityGates: evaluated.qualityGates,
              interface: evaluated.interface,
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
          state: "SOLUTION", what: "solution", reasons: drafted.reasons,
        }),
      };
    }

    const solution = drafted.value;
    const revision = await this.store.saveDraftSolution(
      requirementId,
      JSON.stringify(solution),
      runId(requirementId),
    );
    if (solutionNeedsApproval(solution)) {
      await this.publisher.publish(requirementId);
      return { kind: "drafted", revision, awaiting: approvalReasons(solution) };
    }
    // Nothing here is a person's call, so waiting for one would only add
    // latency. The confirmation is still recorded, with `auto` as its source,
    // so the page and the audit trail say who let it through.
    await this.store.confirmSolution(
      requirementId,
      revision,
      `solution-auto:${requirementId}:${revision}`,
      "auto",
      runId(requirementId),
    );
    await this.store.transition(requirementId, "SOLUTION", "DECOMPOSING", "system", runId(requirementId));
    await this.publisher.publish(requirementId);
    return { kind: "confirmed", revision, source: "auto" };
  }
}
