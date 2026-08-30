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
