import { describe, expect, it } from "vitest";
import { failureSignature, judgeRegression, type RegressionObservation, type RegressionPolicy } from "./verdict.js";

const policy: RegressionPolicy = { windowSize: 10, failureRateThreshold: 0.5, minFailures: 3 };

function runs(pattern: string, signature = "sig-a"): RegressionObservation[] {
  return [...pattern].map((mark) => (mark === "F"
    ? { outcome: "failed" as const, failureSignature: signature }
    : { outcome: "passed" as const }));
}

describe("failureSignature", () => {
  it("gives two runs of the same break the same name", () => {
    const first = failureSignature("AssertionError: expected 3 to be 4\n  at D:/work/a/src/cart.test.ts:12:9 (43ms)");
    const second = failureSignature("AssertionError: expected 3 to be 4\n  at C:/other/b/src/cart.test.ts:87:2 (1.2s)");
    expect(first).toBe(second);
  });

  it("keeps two different breaks apart", () => {
    expect(failureSignature("AssertionError: expected 3 to be 4"))
      .not.toBe(failureSignature("TypeError: cart is not iterable"));
  });

  it("ignores case and incidental whitespace", () => {
    expect(failureSignature("  Timeout   waiting for element  "))
      .toBe(failureSignature("timeout waiting for element"));
  });
});

describe("judgeRegression", () => {
  it("says nothing about a scenario that keeps passing", () => {
    expect(judgeRegression(runs("PPPPPP"), policy)).toEqual({ kind: "stable" });
  });

  it("treats a single failure as a suspect, not a break", () => {
    expect(judgeRegression(runs("FPPPPPPPPP"), policy)).toMatchObject({ kind: "suspect", failures: 1 });
  });

  it("leaves a scenario that fails about a third of the time alone", () => {
    // Three failures in ten runs is flakiness; a card here buries the real ones.
    expect(judgeRegression(runs("FPPFPPPFPP"), policy)).toMatchObject({ kind: "suspect", failures: 3 });
  });

  it("raises a card for a break that reproduces", () => {
    expect(judgeRegression(runs("FFFFFFPPPP"), policy))
      .toMatchObject({ kind: "raise", failures: 6, signature: "sig-a" });
  });

  it("will not raise a card when every failure looks different", () => {
    const observations: RegressionObservation[] = [
      { outcome: "failed", failureSignature: "sig-a" },
      { outcome: "failed", failureSignature: "sig-b" },
      { outcome: "failed", failureSignature: "sig-c" },
      { outcome: "failed", failureSignature: "sig-d" },
      { outcome: "failed", failureSignature: "sig-e" },
      { outcome: "failed", failureSignature: "sig-f" },
    ];
    expect(judgeRegression(observations, policy)).toMatchObject({ kind: "suspect" });
  });

  it("names the break that dominates the window", () => {
    const observations: RegressionObservation[] = [
      ...runs("FFFF", "sig-real"),
      { outcome: "failed", failureSignature: "sig-noise" },
    ];
    expect(judgeRegression(observations, policy)).toMatchObject({ kind: "raise", signature: "sig-real" });
  });

  it("looks only at the most recent window", () => {
    const observations = [...runs("PPPPPPPPPP"), ...runs("FFFFFFFFFF")];
    expect(judgeRegression(observations, policy)).toEqual({ kind: "stable" });
  });
});
