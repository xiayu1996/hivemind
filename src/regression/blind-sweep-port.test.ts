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
  reasons: [],
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
    specificationFor: async (ids) => new Map(ids.map((id) => [id, `frozen text of ${id}`])),
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

  it("judges nothing when the sweep itself never reached a verdict", async () => {
    // Calling this a failure raised regression cards against the code for a
    // box that lost the run, and attribution then went bisecting for the
    // commit that broke it.
    const { sweep } = port(verifyResult("inconclusive", [], { runnerFailure: "VERIFY returned no assistant verdict" }));

    const result = await sweep.run({ pool: "main", branch: "main", scenarioIds: ["S-VAL-01-a"] });

    expect(result.outcomes).toEqual([]);
    expect(result.inconclusive).toEqual(["S-VAL-01-a"]);
  });

  it("hands the verifier the frozen text of each scenario, not only its id", async () => {
    const { sweep, executor } = port(verifyResult("accepted", []));

    await sweep.run({ pool: "epic", branch: "epic/M2", scenarioIds: ["S-M2-01-a"] });

    const [input] = executor.run.mock.calls.at(0) as unknown as [{ specification: string }];
    const specification = input.specification;
    expect(specification).toContain("frozen text of S-M2-01-a");
  });

  it("refuses to sweep a scenario whose frozen text it cannot find", async () => {
    const executor = { run: vi.fn(async () => verifyResult("accepted", [])) };
    const sweep = new BlindSweepPort({
      worktreeFor: async () => "D:/pool",
      specificationFor: async () => new Map(),
      executor,
      git: { run: vi.fn(async () => "rev-abc\n") },
      evidenceRoot: "D:/evidence",
      auditPath: "D:/evidence/audit.jsonl",
      allowedHosts: ["localhost"],
    });

    await expect(sweep.run({ pool: "main", branch: "main", scenarioIds: ["S-VAL-01-a"] }))
      .rejects.toThrow("no frozen text");
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("never reuses a coding session id, which the database forbids", async () => {
    const { sweep, executor } = port(verifyResult("accepted", []));

    await sweep.run({ pool: "main", branch: "main", scenarioIds: ["S-VAL-01-a"] });

    expect(executor.run.mock.calls.at(0)?.at(0)).toMatchObject({ codeSessionId: "regression:main:rev-abc" });
  });
});
