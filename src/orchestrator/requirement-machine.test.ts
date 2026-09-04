import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_TRANSITIONS,
  RequirementTransitionError,
  assertRequirementTransition,
} from "./requirement-machine.js";

type State = keyof typeof REQUIREMENT_TRANSITIONS;

describe("declared transitions", () => {
  it("accepts every declared edge", () => {
    for (const [from, destinations] of Object.entries(REQUIREMENT_TRANSITIONS)) {
      for (const to of destinations) {
        expect(() => assertRequirementTransition(from as State, to, "system")).not.toThrow();
      }
    }
  });

  it("rejects undeclared edges", () => {
    expect(() => assertRequirementTransition("CLARIFY", "EXECUTING", "system")).toThrow(RequirementTransitionError);
    expect(() => assertRequirementTransition("DECOMPOSING", "DONE", "system")).toThrow(RequirementTransitionError);
    expect(() => assertRequirementTransition("DONE", "ACCEPTANCE", "human")).toThrow(RequirementTransitionError);
  });
});

describe("gates that a drag must not skip", () => {
  it("sends a rejected PRD back to clarification instead of forward", () => {
    expect(() => assertRequirementTransition("PRD_CONFIRM", "CLARIFY", "system")).not.toThrow();
    expect(() => assertRequirementTransition("CLARIFY", "DECOMPOSING", "system")).toThrow(RequirementTransitionError);
  });

  it("sends an acceptance gap back through decomposition, not straight to done", () => {
    expect(() => assertRequirementTransition("ACCEPTANCE", "DECOMPOSING", "system")).not.toThrow();
    expect(() => assertRequirementTransition("EXECUTING", "DONE", "system")).toThrow(RequirementTransitionError);
  });
});

describe("human parking", () => {
  it("lets a human park from any nonterminal state", () => {
    for (const from of ["CLARIFY", "PRD_CONFIRM", "DECOMPOSING", "EXECUTING", "ACCEPTANCE"] as const) {
      expect(() => assertRequirementTransition(from, "HUMAN_PARKED", "human")).not.toThrow();
    }
  });

  it("refuses to park from a terminal state or on the system's own authority", () => {
    expect(() => assertRequirementTransition("DONE", "HUMAN_PARKED", "human")).toThrow(RequirementTransitionError);
    expect(() => assertRequirementTransition("FAILED", "HUMAN_PARKED", "human")).toThrow(RequirementTransitionError);
    expect(() => assertRequirementTransition("CLARIFY", "HUMAN_PARKED", "system")).toThrow(RequirementTransitionError);
  });

  it("rejects every system transition out of HUMAN_PARKED", () => {
    for (const to of Object.keys(REQUIREMENT_TRANSITIONS) as State[]) {
      expect(() => assertRequirementTransition("HUMAN_PARKED", to, "system", to)).toThrow(RequirementTransitionError);
    }
  });

  it("allows only a human to restore the state saved before parking", () => {
    expect(() => assertRequirementTransition("HUMAN_PARKED", "ACCEPTANCE", "human", "ACCEPTANCE")).not.toThrow();
    expect(() => assertRequirementTransition("HUMAN_PARKED", "DONE", "human", "ACCEPTANCE")).toThrow(
      RequirementTransitionError,
    );
    expect(() => assertRequirementTransition("HUMAN_PARKED", "CLARIFY", "human")).toThrow(RequirementTransitionError);
  });
});
