import { describe, expect, it, vi } from "vitest";
import type { DefinitionOfDone } from "../pipeline/dod.js";
import type { UiReviewResult } from "../verify/ui-review.js";
import { reviewableScenarios, UiReviewedVerifyPort } from "./ui-reviewed-verify-port.js";
import type { ManagedVerifyInput, ManagedVerifyResult } from "./story-worker.js";

function dod(layers: Array<DefinitionOfDone["scenarios"][number]["layers"]>): DefinitionOfDone {
  return {
    story_id: "S-EPIC-01",
    design_summary: "结算页显示运费",
    scenarios: layers.map((given, index) => ({
      id: `S-EPIC-01-s${index}`,
      given: "买家在结算页",
      when: "页面加载完成",
      // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external DoD contract.
      then: "看到运费金额",
      layers: given,
    })),
    baseline: { type: "acceptance_test" },
    acceptance_criteria: ["买家看到运费"],
    predicted_footprint: ["src/checkout"],
    depends_on: [],
  };
}

function verifyInput(definitionOfDone: DefinitionOfDone): ManagedVerifyInput {
  return {
    runId: "run-1",
    round: 1,
    prompt: "verify",
    context: { cardId: "story-1" } as ManagedVerifyInput["context"],
    codeSessionId: "code.jsonl",
    definitionOfDone,
  };
}

function functionalResult(overrides: Partial<ManagedVerifyResult> = {}): ManagedVerifyResult {
  return {
    sessionId: "verify.jsonl",
    verdict: "accepted",
    failedScenarios: [],
    evidenceDir: "/evidence/run-1",
    screenshots: [{ scenarioId: "S-EPIC-01-s0", path: "/evidence/run-1/checkout.png" }],
    artifact: JSON.stringify({ verdict: "accepted" }),
    ...overrides,
  };
}

function reviewResult(overrides: Partial<UiReviewResult> = {}): UiReviewResult {
  return {
    verdict: "accepted",
    failedScenarios: [],
    acceptance: [{ id: "S-EPIC-01-s0", status: "passed" }],
    findings: [{ area: "layout", severity: "major", note: "运费与总价没有对齐" }],
    validationErrors: [],
    runnerFailure: null,
    reviewSessionId: "ui-review.jsonl",
    images: 1,
    events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
    ...overrides,
  };
}

function port(options: {
  functional: ManagedVerifyResult;
  review?: UiReviewResult;
  onReview?: (input: unknown) => void;
  publish?: (input: { text: string }) => Promise<void>;
  friction?: (input: { cardId: string; runId: string; kind: string; detail: string }) => Promise<void>;
}) {
  const review = vi.fn(async (given: unknown) => {
    options.onReview?.(given);
    return options.review ?? reviewResult();
  });
  const instance = new UiReviewedVerifyPort({
    functional: { run: async () => options.functional },
    review: { run: review as never },
    worktreePath: "/work",
    evidenceRoot: "/evidence",
    auditPath: "/evidence/audit.jsonl",
    allowedHosts: ["localhost"],
    storyTitle: async () => ({ title: "买家看到运费", businessGoal: "下单前知道总价" }),
    ...(options.publish ? { publishFindings: options.publish as never } : {}),
    ...(options.friction ? { recordFriction: options.friction as never } : {}),
  });
  return { instance, review };
}

describe("reviewableScenarios", () => {
  it("keeps only the scenarios a person can look at", () => {
    const scenarios = reviewableScenarios(dod([["unit"], ["ui"], ["e2e", "integration"]]));
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["S-EPIC-01-s1", "S-EPIC-01-s2"]);
  });
});

describe("UiReviewedVerifyPort", () => {
  it("does not buy a review for a round that is already going back to CODE", async () => {
    const { instance, review } = port({
      functional: functionalResult({ verdict: "rejected", failedScenarios: ["S-EPIC-01-s0"] }),
    });
    const result = await instance.run(verifyInput(dod([["ui"]])));
    expect(review).not.toHaveBeenCalled();
    expect(result.verdict).toBe("rejected");
  });

  it("does not buy a review for a Story with no interface", async () => {
    const { instance, review } = port({ functional: functionalResult() });
    await instance.run(verifyInput(dod([["unit"], ["integration"]])));
    expect(review).not.toHaveBeenCalled();
  });

  it("sends only the screenshots of the scenarios it is reviewing", async () => {
    let seen: { screenshots: Array<{ scenarioId: string }> } | undefined;
    const { instance } = port({
      functional: functionalResult({
        screenshots: [
          { scenarioId: "S-EPIC-01-s0", path: "/evidence/run-1/ui.png" },
          { scenarioId: "S-EPIC-01-s1", path: "/evidence/run-1/unit.png" },
        ],
      }),
      onReview: (input) => {
        seen = input as typeof seen;
      },
    });
    await instance.run(verifyInput(dod([["ui"], ["unit"]])));
    expect(seen?.screenshots.map((shot) => shot.scenarioId)).toEqual(["S-EPIC-01-s0"]);
  });

  it("delivers the Story despite findings about how it looks, and still reports them", async () => {
    const published: string[] = [];
    const { instance } = port({
      functional: functionalResult(),
      publish: async (input) => {
        published.push(input.text);
      },
    });
    const result = await instance.run(verifyInput(dod([["ui"]])));
    expect(result.verdict).toBe("accepted");
    expect(published[0]).toContain("对齐");
    expect(JSON.parse(result.artifact).uiReview.findings).toHaveLength(1);
  });

  it("sends the Story back to CODE when the function is not on the screen", async () => {
    const { instance } = port({
      functional: functionalResult(),
      review: reviewResult({
        verdict: "rejected",
        failedScenarios: ["S-EPIC-01-s0"],
        acceptance: [{ id: "S-EPIC-01-s0", status: "failed", reason: "结算页没有运费字段" }],
      }),
    });
    const result = await instance.run(verifyInput(dod([["ui"]])));
    expect(result.verdict).toBe("rejected");
    expect(result.failedScenarios).toEqual(["S-EPIC-01-s0"]);
    // The convergence criterion may count it: a missing button is a code failure.
    expect(result.codeFailedScenarios).toEqual(["S-EPIC-01-s0"]);
  });

  it("keeps a scenario the reviewer lost to a 500 out of the failed set", async () => {
    // S-E3OVERVIEW-01, 2026-09-10: two of three refusals named a 500 raised by
    // the stub server the reviewer had written itself, and the failed set grew
    // enough to break convergence and park a card whose code had not regressed.
    const friction: Array<{ cardId: string; runId: string; kind: string; detail: string }> = [];
    const { instance } = port({
      functional: functionalResult(),
      review: reviewResult({
        verdict: "rejected",
        failedScenarios: ["S-EPIC-01-s0", "S-EPIC-01-s1"],
        acceptance: [
          { id: "S-EPIC-01-s0", status: "failed", reason: "结算页没有运费字段" },
          { id: "S-EPIC-01-s1", status: "failed", reason: "点击入口后看到 HTTP 500" },
        ],
      }),
      friction: async (input) => {
        friction.push(input);
      },
    });
    const result = await instance.run(verifyInput(dod([["ui"], ["ui"]])));
    expect(result.verdict).toBe("rejected");
    expect(result.failedScenarios).toEqual(["S-EPIC-01-s0"]);
    expect(result.codeFailedScenarios).toEqual(["S-EPIC-01-s0"]);
    expect(friction).toEqual([]);
  });

  it("accepts the round when every refusal was the environment, and records it as friction", async () => {
    const friction: Array<{ cardId: string; runId: string; kind: string; detail: string }> = [];
    const { instance } = port({
      functional: functionalResult(),
      review: reviewResult({
        verdict: "rejected",
        failedScenarios: ["S-EPIC-01-s0"],
        acceptance: [{ id: "S-EPIC-01-s0", status: "failed", reason: "页面返回 HTTP 503，服务没起来" }],
      }),
      friction: async (input) => {
        friction.push(input);
      },
    });
    const result = await instance.run(verifyInput(dod([["ui"]])));
    expect(result.verdict).toBe("accepted");
    expect(friction).toMatchObject([{ kind: "ui_review_environment" }]);
  });

  it("records a review that could not run as our friction, not as the Story's failure", async () => {
    const friction: Array<{ cardId: string; runId: string; kind: string; detail: string }> = [];
    const { instance } = port({
      functional: functionalResult(),
      review: reviewResult({ verdict: "inconclusive", findings: [], runnerFailure: "browser never started" }),
      friction: async (input) => {
        friction.push(input);
      },
    });
    const result = await instance.run(verifyInput(dod([["ui"]])));
    expect(result.verdict).toBe("accepted");
    expect(friction).toEqual([{
      cardId: "story-1",
      runId: "run-1",
      kind: "ui_review_inconclusive",
      detail: "browser never started",
    }]);
  });
});
