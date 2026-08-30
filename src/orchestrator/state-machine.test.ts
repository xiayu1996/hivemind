import { describe, expect, it } from "vitest";
import {
  EPIC_TRANSITIONS,
  STORY_TRANSITIONS,
  StateTransitionError,
  assertEpicTransition,
  assertStoryTransition,
} from "./state-machine.js";

describe("declared transitions", () => {
  it("accepts every Epic edge", () => {
    for (const [from, destinations] of Object.entries(EPIC_TRANSITIONS)) {
      for (const to of destinations) {
        expect(() => assertEpicTransition(from as keyof typeof EPIC_TRANSITIONS, to)).not.toThrow();
      }
    }
  });

  it("accepts every Story edge", () => {
    for (const [from, destinations] of Object.entries(STORY_TRANSITIONS)) {
      for (const to of destinations) {
        expect(() => assertStoryTransition(from as keyof typeof STORY_TRANSITIONS, to, "system")).not.toThrow();
      }
    }
  });
});

describe("rejection", () => {
  it("rejects undeclared transitions", () => {
    expect(() => assertEpicTransition("INTAKE", "DONE")).toThrow(StateTransitionError);
    expect(() => assertStoryTransition("QUEUED", "MERGE", "system")).toThrow(StateTransitionError);
    expect(() => assertStoryTransition("DELIVERED", "CODE", "system")).toThrow(StateTransitionError);
  });

  it("lets a human park from any nonterminal state", () => {
    for (const from of ["QUEUED", "DESIGN", "CODE", "VERIFY", "NEEDS_INPUT"] as const) {
      expect(() => assertStoryTransition(from, "HUMAN_PARKED", "human")).not.toThrow();
    }
  });

  it("rejects every system transition out of HUMAN_PARKED", () => {
    for (const to of Object.keys(STORY_TRANSITIONS) as Array<keyof typeof STORY_TRANSITIONS>) {
      expect(() => assertStoryTransition("HUMAN_PARKED", to, "system")).toThrow(StateTransitionError);
    }
  });

  it("allows only a human to restore the state saved before parking", () => {
    expect(() => assertStoryTransition("HUMAN_PARKED", "VERIFY", "human", "VERIFY")).not.toThrow();
    expect(() => assertStoryTransition("HUMAN_PARKED", "CODE", "human", "VERIFY")).toThrow(StateTransitionError);
  });
});
