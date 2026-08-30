import { describe, expect, it, vi } from "vitest";
import { verifyCompletion, type CompletionJudge } from "./completion-verifier.js";

const input = {
  phase: "CODE",
  claimedArtifact: "Implemented the discount.",
  sideEffects: { changedFiles: ["src/cart.ts"], failedScenarios: [] },
};

describe("verifyCompletion", () => {
  it("accepts a valid single-call done judgment", async () => {
    const complete = vi.fn(async () => JSON.stringify({ done: true, reason: "Evidence is complete." }));
    const judge: CompletionJudge = { complete };
    expect(await verifyCompletion(judge, input)).toEqual({
      done: true,
      reason: "Evidence is complete.",
      feedback: null,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("injects a rejection reason back into the same round", async () => {
    const judge: CompletionJudge = {
      complete: async () => JSON.stringify({ done: false, reason: "No passing evidence for S-1." }),
    };
    expect(await verifyCompletion(judge, input)).toEqual({
      done: false,
      reason: "No passing evidence for S-1.",
      feedback: "Completion verifier rejected this exit: No passing evidence for S-1.",
    });
  });

  it("fails closed on model errors and malformed output", async () => {
    await expect(verifyCompletion({ complete: async () => { throw new Error("provider down"); } }, input))
      .resolves.toMatchObject({ done: false, reason: "completion verifier failed: provider down" });
    await expect(verifyCompletion({ complete: async () => "looks good" }, input))
      .resolves.toMatchObject({ done: false, reason: expect.stringContaining("invalid output") });
  });
});
