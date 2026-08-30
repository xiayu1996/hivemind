import { describe, expect, it, vi } from "vitest";
import { BlindSweepPort } from "./blind-sweep-port.js";
import type { BlindVerifyResult } from "../verify/executor.js";

function verifyResult(
  verdict: BlindVerifyResult["record"]["verdict"],
  failedScenarios: string[],
  overrides: Partial<BlindVerifyResult> = {},
): BlindVerifyResult {
  return {
    record: {
      cardId: "regression:main",
      round: 1,
      codeSessionId: "regression:main:rev",
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
    ...overrides,
  };
}

function port(result: BlindVerifyResult) {
  const executor = { run: vi.fn(async () => result) };
  const git = { run: vi.fn(async () => "rev-abc\n") };
  const sweep = new BlindSweepPort({
    worktreeFor: async () => "D:/pool",
    executor,
    git,
    evidenceRoot: "D:/evidence",
    auditPath: "D:/evidence/audit.jsonl",
    allowedHosts: ["localhost"],
  });
  return { sweep, executor, git };
}

describe("BlindSweepPort", () => {
  it("reports one outcome per scenario against the revision it swept", async () => {
    const { sweep, executor } = port(verifyResult("rejected", ["S-M2-01-b"]));

    await expect(sweep.run({ pool: "epic", branch: "epic/M2", scenarioIds: ["S-M2-01-a", "S-M2-01-b"] }))
      .resolves.toMatchObject({
        revision: "rev-abc",
        outcomes: [
          { scenarioId: "S-M2-01-a", outcome: "passed" },
          { scenarioId: "S-M2-01-b", outcome: "failed" },
        ],
      });
    expect(executor.run.mock.calls.at(0)?.at(0)).toMatchObject({
      worktreePath: "D:/pool",
      declaredScenarioIds: ["S-M2-01-a", "S-M2-01-b"],
    });
  });

  it("counts an inconclusive sweep as a failure for everything in it", async () => {
    const { sweep } = port(verifyResult("inconclusive", [], { runnerFailure: "VERIFY returned no assistant verdict" }));

    const result = await sweep.run({ pool: "main", branch: "main", scenarioIds: ["S-VAL-01-a"] });

    expect(result.outcomes).toMatchObject([{ scenarioId: "S-VAL-01-a", outcome: "failed" }]);
    expect(result.outcomes[0]?.output).toContain("no assistant verdict");
  });

  it("never reuses a coding session id, which the database forbids", async () => {
    const { sweep, executor } = port(verifyResult("accepted", []));

    await sweep.run({ pool: "main", branch: "main", scenarioIds: ["S-VAL-01-a"] });

    expect(executor.run.mock.calls.at(0)?.at(0)).toMatchObject({ codeSessionId: "regression:main:rev-abc" });
  });
});
