import { describe, expect, it } from "vitest";
import { assertStoryTransition } from "../orchestrator/state-machine.js";
import schema from "./notion-schema.json" with { type: "json" };
import {
  HUMAN_WINS_MS,
  interpretComment,
  interpretPropertyChange,
  shouldSuppressSystemProjection,
} from "./intent-interpreter.js";

const status = schema.options.aiStatus;

describe("property intent", () => {
  it("ignores the system shadow value", () => {
    expect(interpretPropertyChange({
      shadowAiStatus: status[1]!, observedAiStatus: status[1]!, internalState: "CODE", now: 1_000,
    })).toEqual({ type: "none" });
  });

  it("turns a human drag to the parked column into the highest-priority intent", () => {
    const intent = interpretPropertyChange({
      shadowAiStatus: status[1]!, observedAiStatus: status[4]!, internalState: "VERIFY", now: 1_000,
    });
    expect(intent).toEqual({ type: "park", previousState: "VERIFY", humanWinsUntil: 121_000 });
    expect(() => assertStoryTransition("VERIFY", "HUMAN_PARKED", "human")).not.toThrow();
  });

  it("restores the saved state when a human drags a parked card out", () => {
    const intent = interpretPropertyChange({
      shadowAiStatus: status[4]!, observedAiStatus: status[1]!, internalState: "HUMAN_PARKED",
      parkedPreviousState: "CODE", now: 2_000,
    });
    expect(intent).toEqual({ type: "resume", state: "CODE", humanWinsUntil: 122_000 });
    expect(() => assertStoryTransition("HUMAN_PARKED", "CODE", "human", "CODE")).not.toThrow();
  });

  it("interprets a drag back to active as continue development", () => {
    expect(interpretPropertyChange({
      shadowAiStatus: status[3]!, observedAiStatus: status[1]!, internalState: "MERGE", now: 3_000,
    })).toEqual({ type: "continue_development", humanWinsUntil: 123_000 });
  });
});

describe("comment intent", () => {
  it("answers a blocker when the Story needs input", () => {
    expect(interpretComment("NEEDS_INPUT", "Use calendar days.")).toEqual({
      type: "answer_blocker", body: "Use calendar days.",
    });
  });

  it("routes other comments as feedback without guessing semantics", () => {
    expect(interpretComment("VERIFY", "The wording is confusing.")).toEqual({
      type: "feedback", body: "The wording is confusing.",
    });
  });
});

describe("human wins window", () => {
  it("suppresses reverse projection for exactly 120 seconds", () => {
    expect(HUMAN_WINS_MS).toBe(120_000);
    expect(shouldSuppressSystemProjection(1_000, 120_999)).toBe(true);
    expect(shouldSuppressSystemProjection(1_000, 121_000)).toBe(false);
  });
});
