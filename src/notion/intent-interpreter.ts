import type { RequirementState } from "../orchestrator/requirement-machine.js";
import type { EpicState, StoryState } from "../orchestrator/state-machine.js";
import schema from "./notion-schema.json" with { type: "json" };

export const HUMAN_WINS_MS = 120_000;

export interface PropertyChangeInput {
  shadowAiStatus: string;
  observedAiStatus: string;
  internalState: StoryState;
  parkedPreviousState?: StoryState;
  now: number;
}

export type PropertyIntent =
  | { type: "none" }
  | { type: "park"; previousState: StoryState; humanWinsUntil: number }
  | { type: "resume"; state: StoryState; humanWinsUntil: number }
  | { type: "continue_development"; humanWinsUntil: number }
  | { type: "unsupported_property_change"; observedAiStatus: string; humanWinsUntil: number };

export type CommentIntent =
  | { type: "answer_blocker"; body: string }
  | { type: "feedback"; body: string };

export type EpicPropertyIntent =
  | { type: "none" }
  | { type: "approve_plan"; humanWinsUntil: number }
  | { type: "accept_epic"; humanWinsUntil: number }
  | { type: "unsupported_property_change"; observedEpicStatus: string; humanWinsUntil: number };

export type EpicCommentIntent = { type: "approve_plan" } | { type: "request_revision" } | { type: "feedback" };

export function interpretPropertyChange(input: PropertyChangeInput): PropertyIntent {
  if (input.observedAiStatus === input.shadowAiStatus) return { type: "none" };
  const humanWinsUntil = input.now + HUMAN_WINS_MS;
  const parkedColumn = schema.options.aiStatus[4]!;
  const activeColumn = schema.options.aiStatus[1]!;

  if (input.observedAiStatus === parkedColumn && input.internalState !== "HUMAN_PARKED") {
    return { type: "park", previousState: input.internalState, humanWinsUntil };
  }
  if (input.internalState === "HUMAN_PARKED" && input.observedAiStatus !== parkedColumn) {
    if (!input.parkedPreviousState || input.parkedPreviousState === "HUMAN_PARKED") {
      throw new Error("a parked Story has no valid previous state to restore");
    }
    return { type: "resume", state: input.parkedPreviousState, humanWinsUntil };
  }
  if (input.observedAiStatus === activeColumn) return { type: "continue_development", humanWinsUntil };
  return { type: "unsupported_property_change", observedAiStatus: input.observedAiStatus, humanWinsUntil };
}

export function interpretEpicPropertyChange(
  shadowEpicStatus: string,
  observedEpicStatus: string,
  internalState: EpicState,
  now: number,
): EpicPropertyIntent {
  if (shadowEpicStatus === observedEpicStatus) return { type: "none" };
  const humanWinsUntil = now + HUMAN_WINS_MS;
  if (internalState === "PLAN_APPROVAL" && observedEpicStatus === schema.options.epicStatus[2]!) {
    return { type: "approve_plan", humanWinsUntil };
  }
  // An Epic with its review request open is accepted by dragging it to the
  // finished column; the merge itself is observed separately.
  if (internalState === "EPIC_ACCEPT" && observedEpicStatus === schema.options.epicStatus[3]!) {
    return { type: "accept_epic", humanWinsUntil };
  }
  return { type: "unsupported_property_change", observedEpicStatus, humanWinsUntil };
}

export function interpretEpicComment(state: EpicState, body: string): EpicCommentIntent {
  const text = body.trim().toLocaleLowerCase();
  if (state !== "PLAN_APPROVAL") return { type: "feedback" };
  if (["批准", "approve", "approved"].includes(text)) return { type: "approve_plan" };
  if (["修改", "请修改拆解方案", "revise", "request changes"].includes(text)) {
    return { type: "request_revision" };
  }
  return { type: "feedback" };
}

export type RequirementPropertyIntent =
  | { type: "none" }
  | { type: "park"; previousState: RequirementState; humanWinsUntil: number }
  | { type: "resume"; state: RequirementState; humanWinsUntil: number }
  | { type: "approve_prd"; humanWinsUntil: number }
  | { type: "accept"; humanWinsUntil: number }
  | { type: "unsupported_property_change"; observedRequirementStatus: string; humanWinsUntil: number };

export type RequirementCommentIntent =
  | { type: "answer"; body: string }
  | { type: "approve_prd" }
  | { type: "request_revision"; body: string }
  | { type: "feedback"; body: string };

export function interpretRequirementPropertyChange(
  shadowRequirementStatus: string,
  observedRequirementStatus: string,
  internalState: RequirementState,
  parkedResumeState: RequirementState | undefined,
  now: number,
): RequirementPropertyIntent {
  if (shadowRequirementStatus === observedRequirementStatus) return { type: "none" };
  const humanWinsUntil = now + HUMAN_WINS_MS;
  const parkedColumn = schema.options.requirementStatus[6]!;
  const decomposingColumn = schema.options.requirementStatus[3]!;
  const acceptedColumn = schema.options.requirementStatus[5]!;

  if (observedRequirementStatus === parkedColumn && internalState !== "HUMAN_PARKED") {
    return { type: "park", previousState: internalState, humanWinsUntil };
  }
  if (internalState === "HUMAN_PARKED" && observedRequirementStatus !== parkedColumn) {
    if (!parkedResumeState || parkedResumeState === "HUMAN_PARKED") {
      throw new Error("a parked requirement has no valid previous state to restore");
    }
    return { type: "resume", state: parkedResumeState, humanWinsUntil };
  }
  if (internalState === "PRD_CONFIRM" && observedRequirementStatus === decomposingColumn) {
    return { type: "approve_prd", humanWinsUntil };
  }
  if (internalState === "ACCEPTANCE" && observedRequirementStatus === acceptedColumn) {
    return { type: "accept", humanWinsUntil };
  }
  return { type: "unsupported_property_change", observedRequirementStatus, humanWinsUntil };
}

/**
 * While a PRD waits for approval, anything a person writes that is not the
 * approval itself is revision feedback: they are reading the PRD, and a
 * comment left there is about the PRD, not idle conversation.
 */
export function interpretRequirementComment(state: RequirementState, body: string): RequirementCommentIntent {
  const text = body.trim();
  if (text === "") throw new Error("a Notion comment cannot be interpreted without text");
  if (state === "CLARIFY") return { type: "answer", body: text };
  if (state === "PRD_CONFIRM") {
    return ["批准", "确认", "approve", "approved"].includes(text.toLocaleLowerCase())
      ? { type: "approve_prd" }
      : { type: "request_revision", body: text };
  }
  return { type: "feedback", body: text };
}

export function interpretComment(state: StoryState, body: string): CommentIntent {
  const text = body.trim();
  if (text === "") throw new Error("a Notion comment cannot be interpreted without text");
  return state === "NEEDS_INPUT"
    ? { type: "answer_blocker", body: text }
    : { type: "feedback", body: text };
}

export function shouldSuppressSystemProjection(lastHumanActionAt: number, now: number): boolean {
  return now - lastHumanActionAt < HUMAN_WINS_MS;
}
