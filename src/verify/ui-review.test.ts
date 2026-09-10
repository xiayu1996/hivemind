import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GuardPolicy } from "../guard/policy.js";
import type { PiRunner, PromptImage, PromptResult, RpcEvent } from "../runner/types.js";
import {
  loadScreenshotImages,
  renderUiFindings,
  UiReviewExecutor,
  validateUiReview,
  type UiReviewInput,
} from "./ui-review.js";

const scratch = mkdtempSync(join(tmpdir(), "hivemind-ui-review-"));

function png(name: string, bytes = 64): string {
  const path = join(scratch, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

function assistant(content: string): RpcEvent {
  return { type: "message_end", message: { role: "assistant", content } };
}

function runner(content: string): PiRunner & { prompts: string[]; sent: PromptImage[][] } {
  const prompts: string[] = [];
  const sent: PromptImage[][] = [];
  return {
    prompts,
    sent,
    alive: true,
    start: vi.fn(async () => undefined),
    setAutoRetry: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ sessionFile: "ui-review.jsonl" })),
    prompt: vi.fn(async (message: string, _timeout?: number, images?: readonly PromptImage[]): Promise<PromptResult> => {
      prompts.push(message);
      sent.push([...(images ?? [])]);
      return {
        settled: true,
        failure: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
        events: [assistant(content)],
      };
    }),
    stop: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    waitingOnUser: [],
    getMessages: vi.fn(async () => []),
    kill: vi.fn(async () => undefined),
  };
}

function input(overrides: Partial<UiReviewInput> = {}): UiReviewInput {
  return {
    cardId: "story-1",
    round: 1,
    storyTitle: "买家可以在结算页看到运费",
    businessGoal: "买家下单前知道总价",
    scenarios: [{ id: "S-EPIC-01-ui", statement: "结算页显示运费金额" }],
    screenshots: [{ scenarioId: "S-EPIC-01-ui", path: png("shots/checkout.png") }],
    worktreePath: join(scratch, "work"),
    evidencePath: join(scratch, "evidence"),
    auditPath: join(scratch, "evidence", "audit.jsonl"),
    allowedHosts: ["localhost"],
    ...overrides,
  };
}

const PASSED = JSON.stringify({
  acceptance: [{ id: "S-EPIC-01-ui", status: "passed", url: "http://localhost:3000/checkout" }],
  findings: [{ area: "layout", severity: "major", note: "运费金额与总价没有对齐", screenshot: "checkout.png" }],
});

describe("loadScreenshotImages", () => {
  it("attaches images in a stable order regardless of how they were listed", async () => {
    const first = png("order/a.png");
    const second = png("order/b.png");
    const forward = await loadScreenshotImages([first, second]);
    const backward = await loadScreenshotImages([second, first]);
    expect(backward.names).toEqual(forward.names);
    expect(forward.names).toEqual(["a.png", "b.png"]);
  });

  it("names what it could not attach instead of failing the review", async () => {
    const loaded = await loadScreenshotImages([join(scratch, "gone.png"), png("kept/one.png")]);
    expect(loaded.names).toEqual(["one.png"]);
    expect(loaded.skipped).toEqual(["gone.png (unreadable)"]);
  });

  it("stops at the image budget so one round cannot attach a filmstrip", async () => {
    const paths = [1, 2, 3].map((index) => png(`budget/${index}.png`, 32));
    const loaded = await loadScreenshotImages(paths, { maxImages: 2, maxTotalBytes: 1024 });
    expect(loaded.names).toHaveLength(2);
    expect(loaded.skipped).toEqual(["3.png (over the 2-image limit)"]);
  });

  it("refuses a file that is not an image, whatever it is named in the evidence directory", async () => {
    const loaded = await loadScreenshotImages([png("kinds/trace.zip")]);
    expect(loaded.images).toEqual([]);
    expect(loaded.skipped).toEqual(["trace.zip (not an image)"]);
  });
});

describe("validateUiReview", () => {
  it("refuses a verdict that skipped a declared scenario or invented one", () => {
    expect(validateUiReview({ acceptance: [{ id: "other", status: "passed" }], findings: [] }, ["declared"]))
      .toEqual(["scenario other was not declared", "scenario declared has no acceptance entry"]);
  });

  it("refuses a rejection with no reason, which nobody can act on", () => {
    expect(validateUiReview({ acceptance: [{ id: "a", status: "failed" }], findings: [] }, ["a"]))
      .toEqual(["scenario a is failed with no reason"]);
  });
});

describe("UiReviewExecutor", () => {
  it("sends the screenshots as images with the first prompt", async () => {
    const fake = runner(PASSED);
    const result = await new UiReviewExecutor({ create: () => fake }).run(input());
    expect(fake.sent[0]).toHaveLength(1);
    expect(fake.sent[0]![0]!.mimeType).toBe("image/png");
    expect(result.images).toBe(1);
    expect(fake.prompts[0]).toContain("checkout.png");
  });

  it("accepts the Story even when the look of it was criticised", async () => {
    // The whole point of the split: taste is reported, never a rejection. A
    // reviewer that could reject on it would reject a different detail every
    // round and the inner loop would never converge.
    const result = await new UiReviewExecutor({ create: () => runner(PASSED) }).run(input());
    expect(result.verdict).toBe("accepted");
    expect(result.failedScenarios).toEqual([]);
    expect(result.findings).toHaveLength(1);
  });

  it("rejects a scenario whose function is not on the screen", async () => {
    const reply = JSON.stringify({
      acceptance: [{ id: "S-EPIC-01-ui", status: "failed", reason: "结算页没有任何运费字段" }],
      findings: [],
    });
    const result = await new UiReviewExecutor({ create: () => runner(reply) }).run(input());
    expect(result.verdict).toBe("rejected");
    expect(result.failedScenarios).toEqual(["S-EPIC-01-ui"]);
  });

  it("is inconclusive rather than rejecting when the reply is not the verdict that was asked for", async () => {
    const result = await new UiReviewExecutor({ create: () => runner("looks good to me") }).run(input());
    expect(result.verdict).toBe("inconclusive");
    expect(result.validationErrors).toEqual(["the reviewer's reply was not the requested JSON"]);
    expect(result.failedScenarios).toEqual([]);
  });

  it("tells the reviewer to open the browser when no screenshot survived", async () => {
    const result = await new UiReviewExecutor({ create: () => runner(PASSED) })
      .run(input({ screenshots: [{ scenarioId: "S-EPIC-01-ui", path: join(scratch, "missing.png") }] }));
    expect(result.images).toBe(0);
  });

  it("passes the guard a read-only policy for the review's own run id", async () => {
    let policy: GuardPolicy | undefined;
    await new UiReviewExecutor({
      create: (given) => {
        policy = given;
        return runner(PASSED);
      },
    }).run(input());
    expect(policy?.runId).toBe("story-1-ui-review-1");
    expect(policy?.phase).toBe("VERIFY");
  });
});

describe("renderUiFindings", () => {
  it("puts the obvious problems first and says the findings do not send the card back", () => {
    const text = renderUiFindings([
      { area: "content", severity: "minor", note: "按钮文案是「提交」而不是「下单」" },
      { area: "layout", severity: "major", note: "运费金额与总价没有对齐" },
    ]);
    expect(text.indexOf("对齐")).toBeLessThan(text.indexOf("下单"));
    expect(text).toContain("不会把卡打回开发");
  });

  it("says so plainly when there is nothing to report", () => {
    expect(renderUiFindings([])).toBe("界面走查没有发现问题。");
  });
});
