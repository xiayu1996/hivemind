import type { TransitionActor } from "./state-machine.js";

export type RequirementState =
  | "CLARIFY"
  | "PRD_CONFIRM"
  | "DECOMPOSING"
  | "EXECUTING"
  | "ACCEPTANCE"
  | "DONE"
  | "HUMAN_PARKED"
  | "FAILED";

/**
 * The requirement layer sits above the Epic machine (03 doc section 7.1).
 * Waiting on a human answer is not a state of its own: the requirement stays in
 * CLARIFY / PRD_CONFIRM / ACCEPTANCE while the person responds, mirroring how a
 * Story waits inside blocking_question semantics rather than a new stop kind.
 */
export const REQUIREMENT_TRANSITIONS: Record<RequirementState, readonly RequirementState[]> = {
  CLARIFY: ["PRD_CONFIRM", "FAILED"],
  PRD_CONFIRM: ["CLARIFY", "DECOMPOSING", "FAILED"],
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
