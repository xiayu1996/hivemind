import { describe, expect, it } from "vitest";
import { classifyConvergence } from "./convergence.js";

describe("classifyConvergence", () => {
  it("treats the first nonempty round as a baseline", () => {
    expect(classifyConvergence([["S-1", "S-2"]])).toEqual({ classification: "baseline", mayContinue: true });
  });

  it("accepts only a strict proper subset", () => {
    expect(classifyConvergence([["S-1", "S-2"], ["S-2"]])).toEqual({
      classification: "converging", mayContinue: true,
    });
    expect(classifyConvergence([["S-1"], []])).toEqual({ classification: "complete", mayContinue: false });
  });

  it("stops on an unchanged or expanded failure set", () => {
    expect(classifyConvergence([["S-1"], ["S-1"]])).toEqual({
      classification: "stalled", mayContinue: false,
    });
    expect(classifyConvergence([["S-1"], ["S-1", "S-2"]])).toEqual({
      classification: "expanded", mayContinue: false,
    });
  });

  it("detects an oscillation even when the last step looks like expansion", () => {
    expect(classifyConvergence([["S-1", "S-2"], ["S-1"], ["S-1", "S-2"]])).toEqual({
      classification: "oscillating", mayContinue: false,
    });
  });

  it("handles an empty history and a clean first round", () => {
    expect(classifyConvergence([])).toEqual({ classification: "no_rounds", mayContinue: false });
    expect(classifyConvergence([[]])).toEqual({ classification: "complete", mayContinue: false });
  });
});
