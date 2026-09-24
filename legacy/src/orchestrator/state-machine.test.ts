import { describe, expect, it } from "vitest";
import {
  epicTransitionStatement,
  storyTransitionStatement,
  EPIC_TRANSITIONS,
  STORY_TRANSITIONS,
  StateTransitionError,
  assertEpicTransition,
  assertStoryTransition,
  isForwardStoryTransition,
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

describe("isForwardStoryTransition", () => {
  it.each([
    ["QUEUED", "SHAPE", true],
    ["SHAPE", "DESIGN", true],
    ["SPECIFY", "REGRESSION_FIX", true],
    ["REGRESSION_FIX", "VERIFY", true],
    ["MERGE", "DELIVERED", true],
    ["VERIFY", "CODE", false],
    ["MERGE", "CODE", false],
    ["CODE", "SHAPE", false],
    ["DESIGN", "NEEDS_INPUT", false],
    ["NEEDS_INPUT", "CODE", false],
    ["CODE", "HUMAN_PARKED", false],
    ["DELIVERED", "SPECIFY", false],
  ] as const)("%s -> %s is forward: %s", (from, to, forward) => {
    expect(isForwardStoryTransition(from, to)).toBe(forward);
  });
});

describe("guarded transition statements", () => {
  it("guards the row with the same state it declared, so the two cannot drift", () => {
    const statement = epicTransitionStatement({ epicId: "E-1", from: "EXECUTING", to: "BLOCKED", at: 10 });
    expect(statement.sql).toContain("WHERE id = ? AND state = ?");
    expect(statement.args).toEqual(["BLOCKED", 10, "E-1", "EXECUTING"]);
  });

  it("refuses to build a write for an edge the graph does not declare", () => {
    expect(() => epicTransitionStatement({ epicId: "E-1", from: "DONE", to: "EXECUTING", at: 10 }))
      .toThrow(StateTransitionError);
    expect(() => storyTransitionStatement({ cardId: "S-1", from: "DELIVERED", to: "MERGE", at: 10 }))
      .toThrow(StateTransitionError);
  });

  it("carries the columns that travel with a state, and the caller's further condition", () => {
    expect(storyTransitionStatement({
      cardId: "S-1", from: "DELIVERED", to: "SPECIFY", at: 10, set: { phase: "REGRESSION_FIX", priority: 0 },
    }).args).toEqual(["SPECIFY", 10, "REGRESSION_FIX", 0, "S-1", "DELIVERED"]);

    const guarded = epicTransitionStatement({
      epicId: "E-1", from: "EPIC_ACCEPT", to: "EXECUTING", at: 10, set: { mrUrl: null },
      requires: { sql: "mr_url = ?", args: ["https://example.test/1"] },
    });
    expect(guarded.sql).toContain("mr_url = NULL");
    expect(guarded.sql).toContain("AND mr_url = ?");
    expect(guarded.args).toEqual(["EXECUTING", 10, "E-1", "EPIC_ACCEPT", "https://example.test/1"]);
  });
});
