import type { TransitionActor } from "./state-machine.js";

export type RequirementState =
  | "CLARIFY"
  | "PRD_CONFIRM"
  | "SOLUTION"
  | "DECOMPOSING"
  | "EXECUTING"
  | "ACCEPTANCE"
  | "DONE"
  | "HUMAN_PARKED"
  | "FAILED";

/**
 * The requirement layer sits above the Epic machine (03 doc section 7.1).
 * Waiting on a human answer is not a state of its own: the requirement stays in
 * CLARIFY / PRD_CONFIRM / SOLUTION / ACCEPTANCE while the person responds, mirroring how a
 * Story waits inside blocking_question semantics rather than a new stop kind.
 */
export const REQUIREMENT_TRANSITIONS: Record<RequirementState, readonly RequirementState[]> = {
  CLARIFY: ["PRD_CONFIRM", "FAILED"],
  // An approved PRD says what to build, not what to build it with. SOLUTION is
  // where the stack and, for a requirement with an interface, the interface
  // contract are decided once for every card that follows (design 08).
  PRD_CONFIRM: ["CLARIFY", "SOLUTION", "FAILED"],
  // Back to PRD_CONFIRM because a solution can only be written against a
  // requirement that holds still: when the person reads the approach and
  // changes what they want, the PRD is what changed.
  SOLUTION: ["PRD_CONFIRM", "DECOMPOSING", "FAILED"],
  DECOMPOSING: ["EXECUTING", "FAILED"],
  EXECUTING: ["ACCEPTANCE", "FAILED"],
  ACCEPTANCE: ["DONE", "DECOMPOSING", "FAILED"],
  DONE: [],
  HUMAN_PARKED: [],
  FAILED: [],
};

export class RequirementTransitionError extends Error {
  constructor(from: string, to: string, reason?: string) {
    super(`Requirement transition ${from} -> ${to} is not allowed${reason ? `: ${reason}` : ""}`);
    this.name = "RequirementTransitionError";
  }
}

/**
 * HUMAN_PARKED outranks the workflow graph, exactly as it does for a Story:
 * only a human parks, only a human resumes, and resuming must restore the
 * state captured before parking so a drag cannot skip a gate.
 */
export function assertRequirementTransition(
  from: RequirementState,
  to: RequirementState,
  actor: TransitionActor,
  parkedResumeState?: RequirementState,
): void {
  if (from === "HUMAN_PARKED") {
    if (actor !== "human") {
      throw new RequirementTransitionError(from, to, "only a human can resume a parked requirement");
    }
    if (!parkedResumeState || to !== parkedResumeState || to === "HUMAN_PARKED") {
      throw new RequirementTransitionError(from, to, "restore the state captured before parking");
    }
    return;
  }
  if (to === "HUMAN_PARKED") {
    if (actor !== "human" || from === "DONE" || from === "FAILED") {
      throw new RequirementTransitionError(from, to, "only a human can park a nonterminal requirement");
    }
    return;
  }
  if (!REQUIREMENT_TRANSITIONS[from].includes(to)) throw new RequirementTransitionError(from, to);
}
