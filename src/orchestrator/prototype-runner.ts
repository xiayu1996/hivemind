import type { PrototypePageClaim } from "../verify/prototype-exit.js";
import type { RequirementPagePublisher } from "./clarify-loop.js";
import type { PrdScenario } from "./requirement-artifacts.js";
import type { SolutionBody } from "./requirement-solution.js";
import { requirementRunId as runId } from "./requirement-draft.js";
import type { RequirementStore } from "./requirement-store.js";

/**
 * Draws the interface contract for a solution that has one (design 08 section
 * 3.1), before the person is asked to approve either.
 *
 * It runs between the solution being drafted and the solution being read,
 * because those are one decision: approving "a web back office built on the
 * existing stack" without seeing the screens is approving a sentence. The
 * requirement does not gain a state for it -- a prototype that cannot be drawn
 * leaves the requirement in SOLUTION waiting for a person, which is the stop
 * that state already has.
 */

export interface PrototypeRequest {
  requirementId: string;
  title: string;
  /** Which repository the contract is written into. */
  repository: string;
  businessGoal: string;
  scenarios: readonly PrdScenario[];
  /** The screens the approved solution says this requirement needs. */
  interface: NonNullable<SolutionBody["interface"]>;
  /** The approach the person will read beside these screens, so the drawing
   * and the sentence describe the same product. */
  approach: string;
  /** Contract directory inside the repository, as configured. */
  contractRoot: string;
  /** What the person asked to change about earlier drafts, oldest first. */
  revisionFeedback: readonly string[];
}

export interface PrototypeResult {
  pages: readonly PrototypePageClaim[];
  /** Problems with the direction or the page list itself, written for the
   * person who approves the solution. The prototype may not fix these: a
   * drawing that changes the plan is a plan nobody approved. */
  concerns: readonly string[];
}

export interface PrototypePort {
  /** Runs the drawing session, including its own exit checks. Throwing means
   * the rounds ran out with findings still open. */
  run(input: PrototypeRequest): Promise<PrototypeResult>;
}

/** Puts the drawn contract up for review. Returns where a person can read it,
 * or null when this installation has nowhere to put it. */
export interface PrototypeDelivery {
  publish(input: {
    requirementId: string;
    title: string;
    result: PrototypeResult;
  }): Promise<{ url: string } | null>;
}

export type PrototypeOutcome =
  | { kind: "drawn"; revision: number; concerns: readonly string[]; mrUrl: string | null }
  | { kind: "skipped"; reason: string }
  | { kind: "stopped"; reason: string };

export class PrototypeRunner {
  constructor(
    private readonly store: RequirementStore,
    private readonly port: PrototypePort,
    private readonly delivery: PrototypeDelivery,
    private readonly publisher: RequirementPagePublisher,
  ) {}

  /**
   * Draws the contract for the solution revision just drafted.
   *
   * A failed drawing stops the requirement rather than letting the solution go
   * to a person without its screens: the whole point of this step is that the
   * two are approved together, and a solution approved alone would be built
   * against nothing.
   */
  async draw(input: {
    requirementId: string;
    title: string;
    repository: string;
    businessGoal: string;
    scenarios: readonly PrdScenario[];
    solution: SolutionBody;
    revision: number;
    contractRoot: string;
  }): Promise<PrototypeOutcome> {
    if (!input.solution.interface) return { kind: "skipped", reason: "这条需求不涉及界面" };
    if (input.repository === "") return { kind: "skipped", reason: "这条需求还没有目标仓库" };

    const revisionFeedback = await this.store.solutionRevisionFeedback(input.requirementId);
    let result: PrototypeResult;
    try {
      result = await this.port.run({
        requirementId: input.requirementId,
        title: input.title,
        repository: input.repository,
        businessGoal: input.businessGoal,
        scenarios: input.scenarios,
        interface: input.solution.interface,
        approach: input.solution.approach.summary,
        contractRoot: input.contractRoot,
        revisionFeedback,
      });
    } catch (cause) {
      const reason = `界面原型没画成：${cause instanceof Error ? cause.message : String(cause)}`;
      await this.store.stopForHumanInput(
        input.requirementId, "SOLUTION", runId(input.requirementId), reason,
      );
      await this.publisher.publish(input.requirementId);
      return { kind: "stopped", reason };
    }

    // Published before it is recorded: the record is what the page renders, and
    // a record that names no merge request reads as a prototype nobody can see.
    const published = await this.delivery.publish({
      requirementId: input.requirementId,
      title: input.title,
      result,
    });
    await this.store.saveSolutionPrototype(
      input.requirementId,
      input.revision,
      JSON.stringify({ pages: result.pages, concerns: result.concerns }),
      published?.url ?? null,
      runId(input.requirementId),
    );
    return {
      kind: "drawn",
      revision: input.revision,
      concerns: result.concerns,
      mrUrl: published?.url ?? null,
    };
  }
}
