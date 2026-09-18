import { describe, expect, it } from "vitest";
import { assertStoryTransition } from "../orchestrator/state-machine.js";
import schema from "./notion-schema.json" with { type: "json" };
import { STORY_BOARD_STATUS } from "./board-status.js";
import {
  HUMAN_WINS_MS,
  interpretComment,
  interpretEpicComment,
  interpretPropertyChange,
  interpretRequirementComment,
  interpretRequirementPropertyChange,
  shouldSuppressSystemProjection,
} from "./intent-interpreter.js";

const requirementStatus = schema.options.requirementStatus;

describe("property intent", () => {
  it("ignores the system shadow value", () => {
    expect(interpretPropertyChange({
      shadowAiStatus: STORY_BOARD_STATUS.running, observedAiStatus: STORY_BOARD_STATUS.running, internalState: "CODE", now: 1_000,
    })).toEqual({ type: "none" });
  });

  it("turns a human drag to the parked column into the highest-priority intent", () => {
    const intent = interpretPropertyChange({
      shadowAiStatus: STORY_BOARD_STATUS.running, observedAiStatus: STORY_BOARD_STATUS.parked, internalState: "VERIFY", now: 1_000,
    });
    expect(intent).toEqual({ type: "park", previousState: "VERIFY", humanWinsUntil: 121_000 });
    expect(() => assertStoryTransition("VERIFY", "HUMAN_PARKED", "human")).not.toThrow();
  });

  it("restores the saved state when a human drags a parked card out", () => {
    const intent = interpretPropertyChange({
      shadowAiStatus: STORY_BOARD_STATUS.parked, observedAiStatus: STORY_BOARD_STATUS.running, internalState: "HUMAN_PARKED",
      parkedPreviousState: "CODE", now: 2_000,
    });
    expect(intent).toEqual({ type: "resume", state: "CODE", humanWinsUntil: 122_000 });
    expect(() => assertStoryTransition("HUMAN_PARKED", "CODE", "human", "CODE")).not.toThrow();
  });

  // The board no longer has a column for confirming a Story's own review
  // request, so this is a person pulling a card they consider unfinished back.
  it("interprets a drag back to active as continue development", () => {
    expect(interpretPropertyChange({
      shadowAiStatus: STORY_BOARD_STATUS.done, observedAiStatus: STORY_BOARD_STATUS.running, internalState: "MERGE", now: 3_000,
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

describe("requirement property intent", () => {
  it("reads a drag out of PRD confirmation as the approval it is", () => {
    expect(interpretRequirementPropertyChange(
      requirementStatus[2]!, requirementStatus[3]!, "PRD_CONFIRM", undefined, 1_000,
    )).toEqual({ type: "approve_prd", humanWinsUntil: 121_000 });
  });

  it("reads a drag out of solution confirmation as the approval it is", () => {
    expect(interpretRequirementPropertyChange(
      requirementStatus[3]!, requirementStatus[4]!, "SOLUTION", undefined, 1_000,
    )).toEqual({ type: "approve_solution", humanWinsUntil: 121_000 });
  });

  it("reads a drag to the accepted column as acceptance", () => {
    expect(interpretRequirementPropertyChange(
      requirementStatus[5]!, requirementStatus[6]!, "ACCEPTANCE", undefined, 1_000,
    )).toEqual({ type: "accept", humanWinsUntil: 121_000 });
  });

  it("keeps parking above every other reading, and restores what was parked", () => {
    expect(interpretRequirementPropertyChange(
      requirementStatus[1]!, requirementStatus[7]!, "CLARIFY", undefined, 1_000,
    )).toEqual({ type: "park", previousState: "CLARIFY", humanWinsUntil: 121_000 });
    expect(interpretRequirementPropertyChange(
      requirementStatus[7]!, requirementStatus[1]!, "HUMAN_PARKED", "CLARIFY", 1_000,
    )).toEqual({ type: "resume", state: "CLARIFY", humanWinsUntil: 121_000 });
    expect(interpretRequirementPropertyChange(
      requirementStatus[7]!, requirementStatus[1]!, "HUMAN_PARKED", undefined, 1_000,
    )).toEqual({ type: "none" });
  });

  it("refuses to invent a meaning for an unexpected column", () => {
    expect(interpretRequirementPropertyChange(
      requirementStatus[0]!, requirementStatus[6]!, "CLARIFY", undefined, 1_000,
    )).toMatchObject({ type: "unsupported_property_change" });
  });
});

describe("requirement comment intent", () => {
  it("reads a comment on a waiting solution as a verdict on that solution", () => {
    expect(interpretRequirementComment("SOLUTION", "确认")).toEqual({ type: "approve_solution" });
    expect(interpretRequirementComment("SOLUTION", "不要引入新的构建工具"))
      .toEqual({ type: "request_solution_revision", body: "不要引入新的构建工具" });
  });

  it("treats a comment during clarification as an answer", () => {
    expect(interpretRequirementComment("CLARIFY", "值班的人")).toEqual({ type: "answer", body: "值班的人" });
  });

  it("treats anything but approval on a waiting PRD as revision feedback", () => {
    expect(interpretRequirementComment("PRD_CONFIRM", " 批准 ")).toEqual({ type: "approve_prd" });
    expect(interpretRequirementComment("PRD_CONFIRM", "第二条场景不对")).toEqual({
      type: "request_revision", body: "第二条场景不对",
    });
  });

  it("refuses to interpret an empty comment", () => {
    expect(() => interpretRequirementComment("CLARIFY", "  ")).toThrow(/without text/);
  });

  it("reads a wording the four strings miss as an approval once a judge vouched for it", () => {
    // "批准。" with a full stop is today a request to rewrite the PRD.
    const judged = new Set(["批准。", "确认，可以往下走"]);

    expect(interpretRequirementComment("PRD_CONFIRM", " 批准。 ", judged)).toEqual({ type: "approve_prd" });
    expect(interpretRequirementComment("SOLUTION", "确认，可以往下走", judged))
      .toEqual({ type: "approve_solution" });
  });

  it("keeps the whitelist's answer for a comment the judge did not vouch for", () => {
    expect(interpretRequirementComment("PRD_CONFIRM", "第二条场景不对", new Set(["批准。"])))
      .toEqual({ type: "request_revision", body: "第二条场景不对" });
  });

  it("goes on reading approvals with no judge at all", () => {
    expect(interpretRequirementComment("PRD_CONFIRM", "批准")).toEqual({ type: "approve_prd" });
  });
});

describe("Epic comment intent", () => {
  it("reads the approvals it always has", () => {
    expect(interpretEpicComment("PLAN_APPROVAL", " 批准 ")).toEqual({ type: "approve_plan" });
    expect(interpretEpicComment("PLAN_APPROVAL", "Approved")).toEqual({ type: "approve_plan" });
  });

  it("sends the plan back carrying anything else the person wrote", () => {
    // This used to fall through to `feedback`, which does nothing: the person
    // said the split was wrong and the Epic went on waiting in silence.
    expect(interpretEpicComment("PLAN_APPROVAL", "这个拆解不对，第二张卡应该拆成两张"))
      .toEqual({ type: "request_revision", body: "这个拆解不对，第二张卡应该拆成两张" });
    expect(interpretEpicComment("PLAN_APPROVAL", "Request changes"))
      .toEqual({ type: "request_revision", body: "Request changes" });
  });

  it("reads a vouched-for wording as the approval it is", () => {
    expect(interpretEpicComment("PLAN_APPROVAL", "行，就这么干", new Set(["行，就这么干"])))
      .toEqual({ type: "approve_plan" });
  });

  it("never reads one on an Epic that is not waiting for a plan verdict", () => {
    expect(interpretEpicComment("EXECUTING", "批准", new Set(["批准"]))).toEqual({ type: "feedback" });
  });
});

describe("human wins window", () => {
  it("suppresses reverse projection for exactly 120 seconds", () => {
    expect(HUMAN_WINS_MS).toBe(120_000);
    expect(shouldSuppressSystemProjection(1_000, 120_999)).toBe(true);
    expect(shouldSuppressSystemProjection(1_000, 121_000)).toBe(false);
  });
});
