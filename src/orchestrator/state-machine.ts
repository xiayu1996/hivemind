import type { InStatement } from "@libsql/client";

/** A parameterised statement; the object form of `InStatement`, named so a
 * caller can read back what it is about to run. */
export type GuardedStatement = InStatement & { sql: string; args: (string | number)[] };

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
  | "SHAPE"
  | "DESIGN"
  | "SPECIFY"
  | "CODE"
  | "VERIFY"
  | "MERGE"
  | "DELIVERED"
  | "REGRESSION_FIX"
  | "NEEDS_INPUT"
  | "HUMAN_PARKED"
  | "FAILED";

export type TransitionActor = "system" | "human";

/**
 * The only ways a card legitimately stops for a person. The set is closed and
 * the DB enforces it with a CHECK, so a new one is a design decision rather
 * than a call site's improvisation (03 section 1.5).
 *
 * `cost_ceiling_exceeded` is the spend limit, not a loop bound: a card that
 * reaches it has said nothing about whether its work is achievable, and the
 * report attached to it says so.
 */
export type StoryStopReason =
  | "blocking_question"
  | "verify_loop_exceeded"
  | "retry_limit_exceeded"
  | "cost_ceiling_exceeded";

export const EPIC_TRANSITIONS: Record<EpicState, readonly EpicState[]> = {
  INTAKE: ["DECOMPOSE", "BLOCKED", "FAILED"],
  DECOMPOSE: ["PLAN_APPROVAL", "BLOCKED", "FAILED"],
  PLAN_APPROVAL: ["EXECUTING", "DECOMPOSE", "FAILED"],
  EXECUTING: ["EPIC_ACCEPT", "BLOCKED", "FAILED"],
  // EXECUTING: a review request closed without merging reopens execution so a
  // fresh one can be raised.
  EPIC_ACCEPT: ["DONE", "EXECUTING", "FAILED"],
  BLOCKED: ["INTAKE", "DECOMPOSE", "EXECUTING", "FAILED"],
  DONE: [],
  FAILED: [],
};

export const STORY_TRANSITIONS: Record<StoryState, readonly StoryState[]> = {
  QUEUED: ["SHAPE", "NEEDS_INPUT", "FAILED"],
  // SHAPE is the only phase allowed to ask a question, so it is also the only
  // one a person's answer can send a card back to. Every later phase reads a
  // frozen contract and is forbidden to ask.
  SHAPE: ["DESIGN", "NEEDS_INPUT", "FAILED"],
  DESIGN: ["SPECIFY", "SHAPE", "NEEDS_INPUT", "FAILED"],
  // SPECIFY reached from DELIVERED is the narrow rerun a regression opens; it
  // writes the reproduction test and freezes it before any fix is attempted.
  SPECIFY: ["CODE", "REGRESSION_FIX", "SHAPE", "NEEDS_INPUT", "FAILED"],
  // SHAPE from CODE and MERGE: a frozen DoD the current contract rejects sends
  // the Story back to be shaped again instead of parking it. SPECIFY from CODE
  // is the thaw that lets the frozen tests be rewritten.
  CODE: ["VERIFY", "SPECIFY", "SHAPE", "NEEDS_INPUT", "FAILED"],
  VERIFY: ["CODE", "MERGE", "SPECIFY", "NEEDS_INPUT", "FAILED"],
  MERGE: ["DELIVERED", "CODE", "SPECIFY", "SHAPE", "NEEDS_INPUT", "FAILED"],
  DELIVERED: ["SPECIFY"],
  REGRESSION_FIX: ["VERIFY", "DELIVERED", "NEEDS_INPUT", "FAILED"],
  // A Story can stop before its pipeline starts (the worker died in QUEUED);
  // resuming it means queueing it again, not skipping into SHAPE.
  NEEDS_INPUT: ["QUEUED", "SHAPE", "DESIGN", "SPECIFY", "CODE", "VERIFY", "MERGE", "REGRESSION_FIX", "FAILED"],
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
 * The one way an Epic's state is written.
 *
 * The declared edge and the row guard come from the same pair of states, so
 * they cannot drift: every call site used to assert one pair and then hand-write
 * `WHERE state = '<from>'` in its own SQL, which is two copies of the same fact
 * and a silent no-op the day they disagree. The guard is also what makes the
 * write safe to race -- a caller that read the row and then lost it to another
 * process gets `rowsAffected === 0` rather than overwriting the winner.
 *
 * It returns a statement rather than performing the write because these
 * transitions travel in a batch with the events and the board projection they
 * belong with; splitting them would let a state change land without its record.
 */
export function epicTransitionStatement(input: {
  epicId: string;
  from: EpicState;
  to: EpicState;
  at: number;
  /** The review request that travels with the state: a URL when one is
   * raised, null when an Epic goes back to work without it. */
  set?: { mrUrl: string | null };
  /** Anded into the guard, for a caller with a further precondition. */
  requires?: { sql: string; args: readonly (string | number)[] };
}): GuardedStatement {
  assertEpicTransition(input.from, input.to);
  const columns = ["state = ?", "updated_at = ?"];
  const args: (string | number)[] = [input.to, input.at];
  if (input.set) {
    // Null is written as literal SQL rather than as an argument: the argument
    // list stays a list of values a reader can match to the placeholders.
    columns.push(input.set.mrUrl === null ? "mr_url = NULL" : "mr_url = ?");
    if (input.set.mrUrl !== null) args.push(input.set.mrUrl);
  }
  const requires = input.requires ? ` AND ${input.requires.sql}` : "";
  return {
    sql: `UPDATE epics SET ${columns.join(", ")} WHERE id = ? AND state = ?${requires}`,
    args: [...args, input.epicId, input.from, ...(input.requires?.args ?? [])],
  };
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

/**
 * The same guarded write for a Story, for the callers that do not go through
 * the execution store.
 *
 * Most Story transitions belong to `StoryExecutionStore.transition`, which
 * carries the board projection and the event with them. A caller outside it --
 * the regression attributor reopening a delivered card -- still has to be held
 * to the declared graph, and had been writing `state` straight through with no
 * check of any kind.
 */
export function storyTransitionStatement(input: {
  cardId: string;
  from: StoryState;
  to: StoryState;
  at: number;
  actor?: TransitionActor;
  /** Columns that travel with the state, such as the phase a reopened card
   * resumes in and the priority that puts it ahead of ordinary work. */
  set?: { phase?: string; priority?: number };
}): GuardedStatement {
  assertStoryTransition(input.from, input.to, input.actor ?? "system");
  const columns = ["state = ?", "updated_at = ?"];
  const args: (string | number)[] = [input.to, input.at];
  if (input.set?.phase !== undefined) { columns.push("phase = ?"); args.push(input.set.phase); }
  if (input.set?.priority !== undefined) { columns.push("priority = ?"); args.push(input.set.priority); }
  return {
    sql: `UPDATE stories SET ${columns.join(", ")} WHERE id = ? AND state = ?`,
    args: [...args, input.cardId, input.from],
  };
}

/**
 * Where a state sits on the Story's spine. REGRESSION_FIX shares CODE's place:
 * it is the same kind of work reached from a delivered card, and it leaves the
 * same way, through VERIFY.
 */
const STORY_SPINE: Partial<Record<StoryState, number>> = {
  QUEUED: 0, SHAPE: 1, DESIGN: 2, SPECIFY: 3, CODE: 4, REGRESSION_FIX: 4, VERIFY: 5, MERGE: 6, DELIVERED: 7,
};

/**
 * Whether a transition moves the card along the spine rather than back down it
 * or off it.
 *
 * The crash counter is cleared on one of these, which is what makes it a
 * per-phase safety net rather than a card-lifetime one: a run that died in
 * SHAPE says nothing about DESIGN, and counting the two together stopped
 * S-AGENTRULES-01 on the third failure of its whole life. Stops, parks and the
 * lanes that send a card backwards are deliberately not forward: a card that
 * keeps bouncing between two phases is exactly what the counter is for.
 */
export function isForwardStoryTransition(from: StoryState, to: StoryState): boolean {
  const start = STORY_SPINE[from];
  const end = STORY_SPINE[to];
  return start !== undefined && end !== undefined && end > start;
}
