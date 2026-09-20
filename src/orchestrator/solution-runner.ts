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
import type { PrototypeRunner } from "./prototype-runner.js";
import type { RequirementSnapshot, RequirementStore } from "./requirement-store.js";

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
export interface SolutionRunnerOptions {
  attempts?: number;
  /** Draws the screens this solution decided on, before anybody reads either.
   * Absent on an installation that cannot reach a repository to draw into. */
  prototype?: {
    runner: PrototypeRunner;
    /** Where the repository keeps its interface contract. */
    contractRoot: (repository: string) => Promise<string>;
  };
  /**
   * Puts the approved interface contract on the branch the work will be built
   * from. Absent on an installation with no review CLI, which leaves the
   * request open for a person, as it was before this existed.
   */
  landContract?: (requirementId: string) => Promise<void>;
}

export class SolutionRunner {
  constructor(
    private readonly store: RequirementStore,
    private readonly port: SolutionPort,
    private readonly publisher: RequirementPagePublisher,
    private readonly options: SolutionRunnerOptions = {},
  ) {}

  private get attempts(): number {
    return this.options.attempts ?? 2;
  }

  /**
   * Draws the screens a draft says it needs and does not have yet. Returns the
   * stop when the drawing could not be made, and nothing at all when there was
   * nothing to draw.
   */
  private async drawMissingScreens(
    requirement: RequirementSnapshot,
    current: { revision: number; body: string },
  ): Promise<{ kind: "stopped"; reason: string } | undefined> {
    const solution = JSON.parse(current.body) as SolutionBody;
    if (!this.options.prototype || !solution.interface) return undefined;
    if (await this.store.getSolutionPrototype(requirement.id, current.revision)) return undefined;

    const prd = await this.store.getPrd(requirement.id);
    if (!prd || prd.status !== "confirmed") return undefined;
    const body = JSON.parse(prd.body) as { businessGoal: string; scenarios: PrdScenario[] };
    const drawn = await this.options.prototype.runner.draw({
      requirementId: requirement.id,
      title: requirement.title,
      repository: requirement.repo ?? "",
      businessGoal: body.businessGoal,
      scenarios: body.scenarios,
      solution,
      revision: current.revision,
      contractRoot: await this.options.prototype.contractRoot(requirement.repo ?? ""),
    });
    if (drawn.kind === "stopped") return { kind: "stopped", reason: drawn.reason };
    await this.publisher.publish(requirement.id);
    return undefined;
  }

  async advance(requirementId: string): Promise<SolutionOutcome> {
    const requirement = await this.store.getRequirement(requirementId);
    if (requirement.state !== "SOLUTION") {
      throw new Error(`requirement ${requirementId} is ${requirement.state}, not choosing a solution`);
    }
    if (requirement.stopReason) return { kind: "stopped", reason: requirement.stopReason };

    const current = await this.store.getSolution(requirementId);
    if (current?.status === "confirmed") {
      const landed = await this.landApprovedContract(requirementId);
      if (landed) return landed;
      await this.store.transition(requirementId, "SOLUTION", "DECOMPOSING", "system", runId(requirementId));
      await this.publisher.publish(requirementId);
      return { kind: "confirmed", revision: current.revision, source: "human" };
    }
    if (current?.status === "draft") {
      // A draft whose screens were never drawn was interrupted between the two
      // halves of one decision. Resuming finishes it rather than putting the
      // approach up alone: a person asked to approve a sentence with no screens
      // beside it is being asked to approve nothing.
      const missing = await this.drawMissingScreens(requirement, current);
      if (missing) return missing;
      return { kind: "awaiting", revision: current.revision };
    }

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
    // The screens are drawn before the approach is read, because they are one
    // decision: a person who approves "a web back office on the existing
    // stack" without seeing the screens has approved a sentence. A drawing
    // that never passed its own checks stops the requirement here rather than
    // sending the approach on alone (design 08 section 3.1).
    if (this.options.prototype && solution.interface) {
      const drawn = await this.options.prototype.runner.draw({
        requirementId,
        title: requirement.title,
        repository: requirement.repo ?? "",
        businessGoal: body.businessGoal,
        scenarios: body.scenarios,
        solution,
        revision,
        contractRoot: await this.options.prototype.contractRoot(requirement.repo ?? ""),
      });
      if (drawn.kind === "stopped") return { kind: "stopped", reason: drawn.reason };
    }
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
    const landed = await this.landApprovedContract(requirementId);
    if (landed) return landed;
    await this.store.transition(requirementId, "SOLUTION", "DECOMPOSING", "system", runId(requirementId));
    await this.publisher.publish(requirementId);
    return { kind: "confirmed", revision, source: "auto" };
  }

  /**
   * Puts the approved contract on the target branch before the requirement is
   * split.
   *
   * Every later card reads the contract off its own worktree, which is cut
   * from the target branch, so a contract still sitting on its own branch is
   * one no card can see: each Story with a screen stops in SHAPE asking for
   * the token table nobody handed it. Approving the solution is approving the
   * contract -- they were drawn and read together -- so nothing further is
   * asked of a person here. What a person is asked for is the failure: a
   * contract that would not land needs somebody to look at the request, and
   * splitting the requirement first would only queue up that stop once per
   * Story.
   */
  private async landApprovedContract(
    requirementId: string,
  ): Promise<{ kind: "stopped"; reason: string } | undefined> {
    const land = this.options.landContract;
    if (!land) return undefined;
    try {
      await land(requirementId);
      return undefined;
    } catch (cause) {
      const reason = `界面契约没能进入主干：${(cause as Error).message}`;
      await this.store.stopForHumanInput(requirementId, "SOLUTION", runId(requirementId), reason);
      await this.publisher.publish(requirementId);
      return { kind: "stopped", reason };
    }
  }
}
