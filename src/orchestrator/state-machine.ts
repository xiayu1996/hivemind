export type EpicState =
  | "INTAKE"
  | "DECOMPOSE"
  | "PLAN_APPROVAL"
  | "EXECUTING"
  | "EPIC_ACCEPT"
  | "DONE"
  | "BLOCKED"
  | "FAILED";

export type StoryState =
  | "QUEUED"
  | "DESIGN"
  | "CODE"
  | "VERIFY"
  | "MERGE"
  | "DELIVERED"
  | "REGRESSION_FIX"
  | "NEEDS_INPUT"
  | "HUMAN_PARKED"
  | "FAILED";

export type TransitionActor = "system" | "human";

export const EPIC_TRANSITIONS: Record<EpicState, readonly EpicState[]> = {
  INTAKE: ["DECOMPOSE", "BLOCKED", "FAILED"],
  DECOMPOSE: ["PLAN_APPROVAL", "BLOCKED", "FAILED"],
  PLAN_APPROVAL: ["EXECUTING", "DECOMPOSE", "FAILED"],
  EXECUTING: ["EPIC_ACCEPT", "BLOCKED", "FAILED"],
  EPIC_ACCEPT: ["DONE", "EXECUTING", "FAILED"],
  BLOCKED: ["INTAKE", "DECOMPOSE", "EXECUTING", "FAILED"],
  DONE: [],
  FAILED: [],
};

export const STORY_TRANSITIONS: Record<StoryState, readonly StoryState[]> = {
  QUEUED: ["DESIGN", "NEEDS_INPUT", "FAILED"],
  DESIGN: ["CODE", "NEEDS_INPUT", "FAILED"],
  CODE: ["VERIFY", "NEEDS_INPUT", "FAILED"],
  VERIFY: ["CODE", "MERGE", "NEEDS_INPUT", "FAILED"],
  MERGE: ["DELIVERED", "CODE", "NEEDS_INPUT", "FAILED"],
  DELIVERED: ["REGRESSION_FIX"],
  REGRESSION_FIX: ["DELIVERED", "NEEDS_INPUT", "FAILED"],
  NEEDS_INPUT: ["DESIGN", "CODE", "VERIFY", "MERGE", "REGRESSION_FIX", "FAILED"],
  HUMAN_PARKED: [],
  FAILED: [],
};

export class StateTransitionError extends Error {
  constructor(machine: "Epic" | "Story", from: string, to: string, reason?: string) {
    super(`${machine} transition ${from} -> ${to} is not allowed${reason ? `: ${reason}` : ""}`);
    this.name = "StateTransitionError";
  }
}

export function assertEpicTransition(from: EpicState, to: EpicState): void {
  if (!EPIC_TRANSITIONS[from].includes(to)) throw new StateTransitionError("Epic", from, to);
}

/**
 * HUMAN_PARKED outranks the workflow graph. Only a human-originated command can
 * enter it, and the system cannot leave it. Restoration must name the exact
 * state captured before parking so a drag cannot accidentally skip a phase.
 */
export function assertStoryTransition(
  from: StoryState,
  to: StoryState,
  actor: TransitionActor,
  parkedResumeState?: StoryState,
): void {
  if (from === "HUMAN_PARKED") {
    if (actor !== "human") {
      throw new StateTransitionError("Story", from, to, "only a human can resume a parked Story");
    }
    if (!parkedResumeState || to !== parkedResumeState || to === "HUMAN_PARKED") {
      throw new StateTransitionError("Story", from, to, "restore the state captured before parking");
    }
    return;
  }
  if (to === "HUMAN_PARKED") {
    if (actor !== "human" || from === "DELIVERED" || from === "FAILED") {
      throw new StateTransitionError("Story", from, to, "only a human can park a nonterminal Story");
    }
    return;
  }
  if (!STORY_TRANSITIONS[from].includes(to)) throw new StateTransitionError("Story", from, to);
}
