import { describe, expect, it, vi } from "vitest";
import type { PrototypeResult } from "../orchestrator/prototype-runner.js";
import { GitPrototypeDelivery, prototypeBranch } from "./prototype-delivery.js";
import type { GitCommandPort } from "./story-delivery.js";
import type { MRPort } from "./mr/types.js";

const result: PrototypeResult = {
  pages: [
    { file: "pages/board.html", scenarios: ["R-1-01"], visible: [{ role: "button", text: "新建任务" }] },
    { file: "pages/detail.html", scenarios: ["R-1-02"], visible: [{ role: "heading", text: "任务详情" }] },
  ],
  described: [
    { file: "pages/board.html", name: "任务看板", purpose: "看今天要做什么" },
    { file: "pages/detail.html", name: "任务详情", purpose: "看一张卡这一轮做了什么" },
  ],
  concerns: ["页面清单里少了一个筛选页"],
};

function git(staged: string): GitCommandPort & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_cwd, args) => {
      calls.push(args);
      return args[0] === "diff" ? staged : "";
    },
  };
}

function mr(open: string | null = null): MRPort {
  return {
    create: vi.fn(async () => ({ url: "https://example.invalid/mr/7", provider: "github" as const })),
    findOpen: vi.fn(async () => open),
  };
}

function delivery(overrides: { git?: GitCommandPort & { calls: string[][] }; mr?: MRPort } = {}) {
  const port = overrides.git ?? git("docs/prototype/tokens.json\n");
  const review = overrides.mr ?? mr();
  return {
    port,
    review,
    delivery: new GitPrototypeDelivery(review, {
      worktreePath: "/work/prototype/R-1",
      contractRoot: "docs/prototype",
      repository: "acme/widget",
      targetBranch: "main",
      git: port,
    }),
  };
}

const request = { requirementId: "R-1", title: "任务看板", result };

describe("GitPrototypeDelivery", () => {
  it("commits the contract directory and nothing else", async () => {
    const published = delivery();

    await published.delivery.publish(request);

    expect(published.port.calls[0]).toEqual(["add", "--", "docs/prototype"]);
    expect(published.port.calls.some((args) => args[0] === "commit")).toBe(true);
  });

  it("opens the review on its own branch, so the target branch stays untouched", async () => {
    const published = delivery();

    await expect(published.delivery.publish(request)).resolves.toEqual({ url: "https://example.invalid/mr/7" });
    expect(published.review.create).toHaveBeenCalledWith(expect.objectContaining({
      repository: "acme/widget",
      sourceBranch: "prototype/R-1",
      targetBranch: "main",
    }));
  });

  it("tells the reader which page carries which scenario, and what the drawing doubted", async () => {
    const published = delivery();

    await published.delivery.publish(request);

    const body = (published.review.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].body as string;
    expect(body).toContain("`pages/board.html`：R-1-01");
    expect(body).toContain("页面清单里少了一个筛选页");
  });

  it("opens nothing when the drawing changed nothing", async () => {
    const published = delivery({ git: git("") });

    await expect(published.delivery.publish(request)).resolves.toBeNull();
    expect(published.review.create).not.toHaveBeenCalled();
    expect(published.port.calls.some((args) => args[0] === "commit")).toBe(false);
  });

  it("reuses the request a redraw already has open", async () => {
    const published = delivery({ mr: mr("https://example.invalid/mr/3") });

    await expect(published.delivery.publish(request)).resolves.toEqual({ url: "https://example.invalid/mr/3" });
    expect(published.review.create).not.toHaveBeenCalled();
  });

  it("refuses a requirement id that would not be a branch name", () => {
    expect(() => prototypeBranch("R 1; rm -rf /")).toThrow();
  });
});
