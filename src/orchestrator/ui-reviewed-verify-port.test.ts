import { describe, expect, it, vi } from "vitest";
import type { DefinitionOfDone } from "../pipeline/dod.js";
import type { UiReviewResult } from "../verify/ui-review.js";
import type { AppUnderReview } from "../verify/app-under-review.js";
import { reviewableScenarios, UiReviewedVerifyPort, type UiReviewAppOptions } from "./ui-reviewed-verify-port.js";
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
      source: "orders.shipping_fee",
      examples: [{ kind: "shows", text: "运费 ¥12.00" }, { kind: "excludes", text: "运费 --" }],
    })),
    baseline: { type: "acceptance_test" },
    acceptance_criteria: [{ text: "买家看到运费", scenarios: layers.map((_, index) => `S-EPIC-01-s${index}`) }],
    out_of_scope: [],
    relies_on: [],
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
    amendments: [],
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
  app?: UiReviewAppOptions;
  appUnderReview?: () => Pick<AppUnderReview, "start" | "stop" | "seed">;
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
    ...(options.app ? { app: options.app } : {}),
    ...(options.appUnderReview ? { appUnderReview: options.appUnderReview } : {}),
  });
  return { instance, review };
}

function fakeApp(overrides: Partial<Pick<AppUnderReview, "start" | "stop" | "seed">> = {}) {
  const calls: { start: unknown[]; seed: unknown[]; stopped: number } = { start: [], seed: [], stopped: 0 };
  const handle: Pick<AppUnderReview, "start" | "stop" | "seed"> = {
    start: async (given) => {
      calls.start.push(given);
      return { started: true, url: given.readyUrl };
    },
    seed: async (given) => {
      calls.seed.push(given);
      return { ok: true, output: "" };
    },
    stop: async () => {
      calls.stopped += 1;
    },
    ...overrides,
  };
  return { calls, handle };
}

function withSeed(definition: DefinitionOfDone): DefinitionOfDone {
  definition.scenarios[0]!.seed = "一个仓库下有 3 个 Story";
  return definition;
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
        acceptance: [{ id: "S-EPIC-01-s0", status: "failed", reason: "结算页没有运费字段", cites: "看到运费金额" }],
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
          { id: "S-EPIC-01-s0", status: "failed", reason: "结算页没有运费字段", cites: "看到运费金额" },
          { id: "S-EPIC-01-s1", status: "failed", reason: "点击入口后看到 HTTP 500", cites: "看到运费金额" },
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
        acceptance: [{ id: "S-EPIC-01-s0", status: "failed", reason: "页面返回 HTTP 503，服务没起来", cites: "看到运费金额" }],
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
      detail: "S-EPIC-01-s0: browser never started",
    }]);
    expect(JSON.parse(result.artifact).uiReview.inconclusive).toEqual(["S-EPIC-01-s0"]);
  });

  it("names the scenarios the reviewer could not judge, so an accepted round does not hide them", async () => {
    // S-E3OVERVIEW-01: three of four scenarios came back inconclusive for lack
    // of fixture data and the card delivered with nothing on the board saying so.
    const friction: Array<{ kind: string; detail: string }> = [];
    const { instance } = port({
      functional: functionalResult(),
      review: reviewResult({
        acceptance: [
          { id: "S-EPIC-01-s0", status: "passed" },
          { id: "S-EPIC-01-s1", status: "inconclusive", reason: "列表为空，没有数据可看" },
        ],
      }),
      friction: async (input) => {
        friction.push(input);
      },
    });
    const result = await instance.run(verifyInput(dod([["ui"], ["ui"]])));
    expect(result.verdict).toBe("accepted");
    expect(friction).toEqual([{
      cardId: "story-1",
      runId: "run-1",
      kind: "ui_review_inconclusive",
      detail: "S-EPIC-01-s1: 列表为空，没有数据可看",
    }]);
    expect(JSON.parse(result.artifact).uiReview.inconclusive).toEqual(["S-EPIC-01-s1"]);
  });

  describe("with an application to look at", () => {
    const app = { startCommand: ["npm", "run", "dev"], readyUrl: "http://app.local:3000/", readyTimeoutMs: 1000, seedCommand: ["npm", "run", "seed"] };

    it("starts the application in the worktree, seeds each scenario that asks for data, tells the reviewer, and stops it", async () => {
      const { calls, handle } = fakeApp();
      let seen: { appUrl?: string; allowedHosts: string[]; scenarios: Array<{ seed?: string }> } | undefined;
      const { instance } = port({
        functional: functionalResult(),
        onReview: (input) => {
          seen = input as typeof seen;
        },
        app,
        appUnderReview: () => handle,
      });
      const result = await instance.run(verifyInput(withSeed(dod([["ui"], ["ui"]]))));
      expect(result.verdict).toBe("accepted");
      expect(calls.start).toEqual([{ cwd: "/work", command: app.startCommand, readyUrl: app.readyUrl, timeoutMs: 1000 }]);
      expect(calls.seed).toEqual([{ cwd: "/work", command: app.seedCommand, scenarioId: "S-EPIC-01-s0", seed: "一个仓库下有 3 个 Story" }]);
      expect(seen?.appUrl).toBe(app.readyUrl);
      expect(seen?.allowedHosts).toEqual(["localhost", "app.local"]);
      expect(seen?.scenarios.map((scenario) => scenario.seed)).toEqual(["一个仓库下有 3 个 Story", undefined]);
      expect(calls.stopped).toBe(1);
    });

    it("stops the application even when the reviewer throws", async () => {
      const { calls, handle } = fakeApp();
      const { instance } = port({
        functional: functionalResult(),
        onReview: () => {
          throw new Error("reviewer crashed");
        },
        app,
        appUnderReview: () => handle,
      });
      await expect(instance.run(verifyInput(dod([["ui"]])))).rejects.toThrow("reviewer crashed");
      expect(calls.stopped).toBe(1);
    });

    it("keeps the functional acceptance and marks every screen inconclusive when the application will not start", async () => {
      const friction: Array<{ kind: string; detail: string }> = [];
      const { calls, handle } = fakeApp({ start: async () => ({ started: false, reason: "port 3000 never answered" }) });
      const { instance, review } = port({
        functional: functionalResult(),
        friction: async (input) => {
          friction.push({ kind: input.kind, detail: input.detail });
        },
        app,
        appUnderReview: () => handle,
      });
      const result = await instance.run(verifyInput(dod([["ui"], ["unit"], ["e2e"]])));
      expect(review).not.toHaveBeenCalled();
      expect(result.verdict).toBe("accepted");
      expect(friction).toEqual([{ kind: "ui_review_app_unavailable", detail: "port 3000 never answered" }]);
      const uiReview = JSON.parse(result.artifact).uiReview;
      expect(uiReview.verdict).toBe("inconclusive");
      expect(uiReview.inconclusive).toEqual(["S-EPIC-01-s0", "S-EPIC-01-s2"]);
      expect(uiReview.inconclusiveReasons).toEqual([
        { id: "S-EPIC-01-s0", reason: "port 3000 never answered" },
        { id: "S-EPIC-01-s2", reason: "port 3000 never answered" },
      ]);
      expect(calls.stopped).toBe(1);
    });

    it("does not start anything when the repository declares no start command", async () => {
      let created = 0;
      const { instance, review } = port({
        functional: functionalResult(),
        app: { ...app, startCommand: [] },
        appUnderReview: () => {
          created += 1;
          return fakeApp().handle;
        },
      });
      await instance.run(verifyInput(dod([["ui"]])));
      expect(created).toBe(0);
      expect(review).toHaveBeenCalledTimes(1);
    });
  });
});
