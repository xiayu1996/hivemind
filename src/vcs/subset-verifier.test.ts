import { describe, expect, it, vi } from "vitest";
import { blindSubsetVerifier } from "./subset-verifier.js";
import type { BlindVerifyInput, BlindVerifyResult } from "../verify/executor.js";

const base: Omit<BlindVerifyInput, "declaredScenarioIds"> = {
  cardId: "S-M2-02",
  round: 1,
  codeSessionId: "code.jsonl",
  worktreePath: "D:/integration",
  evidencePath: "D:/evidence",
  auditPath: "D:/evidence/audit.jsonl",
  specification: "The affected scenarios still hold on the Epic head.",
  allowedHosts: ["localhost"],
  commitMessages: [],
};

function result(verdict: BlindVerifyResult["record"]["verdict"], failedScenarios: string[]): BlindVerifyResult {
  return {
    record: {
      cardId: "S-M2-02",
      round: 1,
      codeSessionId: "code.jsonl",
      verifySessionId: "verify.jsonl",
      verdict,
      failedScenarios,
      evidenceDir: "D:/evidence",
      createdAt: 1,
    },
    screenshots: [],
    validationErrors: [],
    treeChanged: false,
    runnerFailure: null,
    events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
    messages: [],
  };
}

describe("blindSubsetVerifier", () => {
  it("verifies exactly the subset it was handed, on the integration worktree", async () => {
    const port = { run: vi.fn(async () => result("accepted", [])) };

    await expect(blindSubsetVerifier(port, base)(["S-M2-01-a", "S-M2-02-a"]))
      .resolves.toEqual({ passed: true, scenarioIds: ["S-M2-01-a", "S-M2-02-a"] });
    expect(port.run.mock.calls.at(0)?.at(0)).toMatchObject({
      worktreePath: "D:/integration",
      declaredScenarioIds: ["S-M2-01-a", "S-M2-02-a"],
    });
  });

  it("reports the scenarios that actually failed, not the ones it was asked about", async () => {
    const port = { run: vi.fn(async () => result("rejected", ["S-M2-01-a"])) };

    await expect(blindSubsetVerifier(port, base)(["S-M2-01-a", "S-M2-02-a"]))
      .resolves.toEqual({ passed: false, scenarioIds: ["S-M2-01-a"] });
  });

  it("treats an inconclusive verdict as a failure rather than a pass", async () => {
    const port = { run: vi.fn(async () => result("inconclusive", [])) };

    await expect(blindSubsetVerifier(port, base)(["S-M2-01-a"]))
      .resolves.toMatchObject({ passed: false });
  });
});
