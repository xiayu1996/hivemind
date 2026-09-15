import { describe, expect, it } from "vitest";
import { STORY_PHASES, isStoryPhase } from "./phase.js";
import { ARTIFACT_KINDS, PHASE_CONTRACTS, phaseContract, writesWorktree } from "./phase-contract.js";

describe("the phase registry", () => {
  it("declares every Story phase exactly once, in the order the transition table allows", () => {
    expect(PHASE_CONTRACTS.map((contract) => contract.phase)).toEqual([...STORY_PHASES]);
  });

  it("declares only artifact kinds the ledger knows", () => {
    for (const contract of PHASE_CONTRACTS) {
      expect(contract.produces.length).toBeGreaterThan(0);
      for (const kind of contract.produces) expect(ARTIFACT_KINDS).toContain(kind);
    }
  });

  it("sends every refusal to a phase that exists, and nowhere from a phase nobody may refuse", () => {
    for (const contract of PHASE_CONTRACTS) {
      if (contract.humanCanReject) expect(isStoryPhase(contract.rejectReturnsTo!)).toBe(true);
      else expect(contract.rejectReturnsTo).toBeNull();
    }
  });

  it("lets only SHAPE ask a question, which is what keeps the board from parking on every phase", () => {
    expect(PHASE_CONTRACTS.filter((contract) => contract.mayAskQuestions).map((contract) => contract.phase))
      .toEqual(["SHAPE"]);
  });

  it("keeps the verifier in its own lane, so it can never share a session with the builder", () => {
    expect(phaseContract("VERIFY").lane).toBe("verify");
    for (const contract of PHASE_CONTRACTS.filter((entry) => entry.phase !== "VERIFY")) {
      expect(contract.lane).toBe("build");
    }
  });

  it("says which phases write source, which is what earns a tree-pin and write tools", () => {
    expect(STORY_PHASES.filter((phase) => writesWorktree(phase)))
      .toEqual(["DESIGN", "SPECIFY", "CODE", "REGRESSION_FIX"]);
  });

  it("charges a round for every phase that can fail, and nothing for the one that only reports", () => {
    expect(PHASE_CONTRACTS.filter((contract) => contract.budget === "free").map((contract) => contract.phase))
      .toEqual(["MERGE"]);
  });
});

describe("what a phase accepts back from a session", () => {
  it("turns SHAPE's reply into the frozen contract, its questions and its assumptions", () => {
    const artifacts = phaseContract("SHAPE").parse({
      dod_yaml: "story_id: S-EPIC1-01",
      open_questions: [{ id: "q1", question: "Which currency?", suggestion: "the order's own", blocking: false }],
      assumptions: ["the repository declares no preference"],
    });

    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["dod", "open-questions", "assumptions"]);
    expect(JSON.parse(artifacts[1]!.body)).toHaveLength(1);
  });

  it("defaults SHAPE's optional lists rather than refusing a card that had nothing to ask", () => {
    const artifacts = phaseContract("SHAPE").parse({ dod_yaml: "story_id: S-EPIC1-01" });
    expect(JSON.parse(artifacts[1]!.body)).toEqual([]);
    expect(JSON.parse(artifacts[2]!.body)).toEqual([]);
  });

  it("refuses a reply that carries a key the phase never asked for", () => {
    expect(() => phaseContract("CODE").parse({ implementation: "done", notes: "extra" })).toThrow();
  });

  it("refuses an empty artifact, which is how a phase claims to have finished without saying anything", () => {
    expect(() => phaseContract("CODE").parse({ implementation: "  " })).toThrow();
    expect(() => phaseContract("MERGE").parse({})).toThrow();
  });
});
