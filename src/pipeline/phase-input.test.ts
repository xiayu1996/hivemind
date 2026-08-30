import { describe, expect, it } from "vitest";
import { assemblePhasePrompt, type PhaseInput } from "./phase-input.js";

const base: PhaseInput = {
  cardId: "S-12",
  phase: "CODE",
  round: 2,
  title: "Flat discount is deducted before tax",
  requirement: "A flat coupon must reduce the taxable amount, not the taxed total.",
  repo: "cart",
  branch: "story/epic-3-12",
  specs: [
    { id: "S-EPIC3-02", status: "failing", text: "A five dollar coupon reduces tax owed" },
    { id: "S-EPIC3-01", status: "passing", text: "Subtotal sums price times quantity" },
  ],
  artifacts: [
    { phase: "DESIGN", kind: "summary", body: "  Deduct before tax.  " },
    { phase: "DESIGN", kind: "test-matrix", body: "unit, integration" },
  ],
  feedback: [
    { id: "c-2", author: "ryan", specId: "S-EPIC3-02", body: "  Watch the rounding.  " },
    { id: "c-1", author: "ryan", body: "Do not change the tests." },
  ],
  previousRejections: [
    { phase: "CODE", reason: "implementation is not wired into the approval path" },
    { phase: "CODE", reason: "commits are not named after the scenarios they cover" },
  ],
  evidence: [{ scenarioId: "S-EPIC3-02", path: "/e/2.png", note: "round 1" }],
  failedScenarios: ["S-EPIC3-02", "S-EPIC3-01"],
};

describe("determinism", () => {
  it("produces identical bytes for identical input", () => {
    expect(assemblePhasePrompt(base)).toBe(assemblePhasePrompt(base));
  });

  it("is insensitive to the order of every collection", () => {
    const shuffled: PhaseInput = {
      ...base,
      specs: base.specs.toReversed(),
      artifacts: base.artifacts.toReversed(),
      feedback: base.feedback.toReversed(),
      failedScenarios: base.failedScenarios.toReversed(),
      previousRejections: base.previousRejections.toReversed(),
    };
    expect(assemblePhasePrompt(shuffled)).toBe(assemblePhasePrompt(base));
  });

  it("does not mutate the input it was given", () => {
    const specs = [...base.specs];
    const failed = [...base.failedScenarios];
    assemblePhasePrompt(base);
    expect(base.specs).toEqual(specs);
    expect(base.failedScenarios).toEqual(failed);
  });

  it("changes when the round changes, so rounds are distinguishable", () => {
    expect(assemblePhasePrompt({ ...base, round: 3 })).not.toBe(assemblePhasePrompt(base));
  });
});

describe("self-containment", () => {
  it("carries requirement, specs, prior artifacts and feedback in one text", () => {
    const prompt = assemblePhasePrompt(base);
    expect(prompt).toContain("A flat coupon must reduce the taxable amount");
    expect(prompt).toContain("S-EPIC3-01");
    expect(prompt).toContain("Deduct before tax.");
    expect(prompt).toContain("Do not change the tests.");
    expect(prompt).toContain("S-EPIC3-02: /e/2.png (round 1)");
  });

  it("rebuilds identically from central state with no local cache present", () => {
    // Assembly reads nothing but its argument, which is what makes a card movable
    // between machines: another host with the same rows produces the same prompt.
    const onHostA = assemblePhasePrompt(base);
    const onHostB = assemblePhasePrompt(JSON.parse(JSON.stringify(base)) as PhaseInput);
    expect(onHostB).toBe(onHostA);
  });

  it("names the card, phase and location", () => {
    const prompt = assemblePhasePrompt(base);
    expect(prompt).toContain("# Task S-12 - Flat discount is deducted before tax");
    expect(prompt).toContain("Phase: CODE");
    expect(prompt).toContain("Repository: cart");
    expect(prompt).toContain("Branch: story/epic-3-12");
  });
});

describe("optional sections", () => {
  const minimal: PhaseInput = {
    cardId: "S-1",
    phase: "DESIGN",
    round: 1,
    title: "First",
    requirement: "Do the thing.",
    specs: [],
    artifacts: [],
    feedback: [],
    previousRejections: [],
    evidence: [],
    failedScenarios: [],
  };

  it("omits sections that have no content instead of leaving empty headings", () => {
    const prompt = assemblePhasePrompt(minimal);
    expect(prompt).toContain("## Requirement");
    for (const heading of ["## Specification", "## Human feedback", "## Evidence", "## Scenarios still failing", "Repository:"]) {
      expect(prompt).not.toContain(heading);
    }
  });

  it("still assembles when only some optional data is present", () => {
    const prompt = assemblePhasePrompt({ ...minimal, failedScenarios: ["S-1"] });
    expect(prompt).toContain("## Scenarios still failing");
    expect(prompt).not.toContain("## Specification");
  });
});

describe("formatting", () => {
  it("trims stored bodies so incidental whitespace does not change the bytes", () => {
    const padded = { ...base, requirement: "\n  Do the thing.  \n" };
    const tight = { ...base, requirement: "Do the thing." };
    expect(assemblePhasePrompt(padded)).toBe(assemblePhasePrompt(tight));
  });

  it("ends with exactly one newline", () => {
    const prompt = assemblePhasePrompt(base);
    expect(prompt.endsWith("\n")).toBe(true);
    expect(prompt.endsWith("\n\n")).toBe(false);
  });
});
