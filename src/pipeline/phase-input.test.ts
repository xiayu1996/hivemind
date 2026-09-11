import { describe, expect, it } from "vitest";
import { assemblePhasePrompt, roundTasks, type PhaseInput } from "./phase-input.js";

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
    for (const heading of ["## Specification", "## What this round must do", "## Evidence", "Repository:"]) {
      expect(prompt).not.toContain(heading);
    }
  });

  it("still assembles when only some optional data is present", () => {
    const prompt = assemblePhasePrompt({ ...minimal, failedScenarios: ["S-1"] });
    expect(prompt).toContain("## What this round must do");
    expect(prompt).toContain("[scenario:S-1]");
    expect(prompt).not.toContain("## Specification");
  });
});

describe("what this round must do", () => {
  it("puts the round's tasks before the history and tags each one", () => {
    const prompt = assemblePhasePrompt({
      ...base,
      scenarioFailures: [
        { scenarioId: "S-EPIC3-02", reason: "the tax line still shows $9.00", source: "screen" },
        { scenarioId: "S-EPIC3-02", reason: "expected 8.1, received 9", source: "tests" },
      ],
    });
    const tasks = prompt.indexOf("## What this round must do");
    expect(tasks).toBeGreaterThan(0);
    expect(tasks).toBeLessThan(prompt.indexOf("## Evidence from earlier rounds"));
    expect(tasks).toBeLessThan(prompt.indexOf("## Output of earlier phases"));
    expect(prompt).toContain("- [answer:c-1] ryan answered: Do not change the tests.");
    expect(prompt).toContain("- [answer:c-2] ryan answered on S-EPIC3-02: Watch the rounding.");
    expect(prompt).toContain("- [rejected:CODE] CODE refused the last attempt: commits are not named");
    expect(prompt).toContain("- [scenario:S-EPIC3-02] still failing. the person looking at the screen: the tax line still shows $9.00 the tests: expected 8.1, received 9");
    expect(prompt).toContain("- [scenario:S-EPIC3-01] still failing. No reason was recorded");
    expect(prompt).toContain("addressed <tag>: <what you changed>");
  });

  it("orders tags by stable ids so the same input yields the same tags", () => {
    const tags = roundTasks(base).map((task) => task.tag);
    expect(tags).toEqual([
      "[answer:c-1]",
      "[answer:c-2]",
      "[rejected:CODE]",
      "[rejected:CODE]",
      "[scenario:S-EPIC3-01]",
      "[scenario:S-EPIC3-02]",
    ]);
    expect(roundTasks({ ...base, feedback: base.feedback.toReversed() }).map((task) => task.tag)).toEqual(tags);
  });
});

describe("regression cards", () => {
  it("turns each open card into a tagged task naming the blamed Story and the signature", () => {
    const input = {
      ...base,
      phase: "REGRESSION_FIX" as const,
      regressions: [
        { scenarioId: "S-EPIC3-05", signature: "TypeError: cart is not iterable", attributedStory: "S-EPIC3-02" },
        { scenarioId: "S-EPIC3-04", signature: "expected 8.1, received 9 " },
      ],
    };
    const tags = roundTasks(input).map((task) => task.tag);
    expect(tags.slice(-2)).toEqual(["[regression:S-EPIC3-04]", "[regression:S-EPIC3-05]"]);
    const prompt = assemblePhasePrompt(input);
    expect(prompt).toContain("- [regression:S-EPIC3-05] the scenario fails on the Epic branch since S-EPIC3-02: TypeError: cart is not iterable");
    expect(prompt).toContain("- [regression:S-EPIC3-04] the scenario fails on the Epic branch since an unattributed Story: expected 8.1, received 9");
    expect(assemblePhasePrompt({ ...input, regressions: input.regressions.toReversed() })).toBe(prompt);
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
