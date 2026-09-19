// @scenario S-M2-05-integration
// @scenario S-M2-05-conflict
// @scenario S-M2-05-subset
// @scenario S-M2-05-revision
import { describe, expect, it, vi } from "vitest";
import { EpicMergeFlow } from "./merge-flow.js";

const story = {
  id: "S-M2-05-integration",
  branch: "story/s-m2-05-integration",
  predictedFootprint: ["src/vcs"],
  scenarioIds: ["S-M2-05-integration"],
};

describe("EpicMergeFlow", () => {
  it("S-M2-05-integration creates an Epic branch from main and merges a verified Story without touching main", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "main";
      if (args[0] === "show-ref") throw new Error("missing ref");
      return "";
    }) };
    const verify = vi.fn(async ({ scenarioIds }: { scenarioIds: readonly string[] }) => ({ passed: true as const, scenarioIds }));
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration", mainBranch: "main" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toEqual({
      kind: "merged",
      integrationBranch: "epic/E-1",
      scenarioIds: ["S-M2-05-integration"],
      mrUrl: null,
    });
    expect(calls).toEqual(expect.arrayContaining([
      { cwd: "integration", args: ["switch", "-c", "epic/E-1", "main"] },
      { cwd: "story", args: ["rebase", "epic/E-1"] },
      { cwd: "integration", args: ["merge", "--ff-only", story.branch] },
    ]));
    expect(calls).toContainEqual({ cwd: "integration", args: ["push", "--set-upstream", "origin", "epic/E-1"] });
    expect(calls.some(({ args }) => args[0] === "push" && args.includes("main"))).toBe(false);
    expect(calls.some(({ args }) => args[0] === "merge" && args.includes("main"))).toBe(false);
  });

  it("S-M2-05-revision refuses to merge a revision the re-verification never saw", async () => {
    const revisions = ["aaa111", "bbb222"];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args.join(" ") === "rev-parse HEAD" && cwd === "story") return `${revisions.shift() ?? "bbb222"}\n`;
      return "";
    }) };
    const verify = vi.fn(async ({ scenarioIds }: { scenarioIds: readonly string[] }) => ({ passed: true as const, scenarioIds }));
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration" });

    const result = await flow.merge({ epicId: "E-1", story, integratedStories: [] });
    expect(result.kind).toBe("verification_failed");
    expect((result as { reason?: string }).reason).toContain("moved during re-verification");
    expect(git.run.mock.calls.some(([, args]) => args[0] === "merge")).toBe(false);
  });

  it("S-M2-05-conflict retains only an actual unresolved rebase conflict and never merges it", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args.join(" ") === "rebase epic/E-1") throw new Error("rebase failed");
      if (args.join(" ") === "diff --name-only --diff-filter=U") return "src/vcs/merge-flow.ts\n";
      return "";
    }) };
    const verify = vi.fn();
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toEqual({
      kind: "conflict",
      integrationBranch: "epic/E-1",
      reason: "rebase failed",
      files: ["src/vcs/merge-flow.ts"],
    });
    expect(calls).toContainEqual({ cwd: "story", args: ["diff", "--name-only", "--diff-filter=U"] });
    expect(verify).not.toHaveBeenCalled();
    expect(calls.some(({ args }) => args[0] === "merge")).toBe(false);
  });

  it("S-M2-05-subset does not reverify or merge from a dirty integration worktree", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args.join(" ") === "status --porcelain" && cwd === "integration") return " M unrelated.txt\n";
      return "";
    }) };
    const verify = vi.fn();
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).rejects.toThrow(/integration worktree has uncommitted changes/);
    expect(calls).toContainEqual({ cwd: "integration", args: ["status", "--porcelain"] });
    expect(verify).not.toHaveBeenCalled();
    expect(calls.some(({ args }) => args[0] === "rebase" || args[0] === "merge")).toBe(false);
  });

  it("S-M2-05-subset blocks integration when the pending Story has no scenario mapping", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      return "";
    }) };
    const verify = vi.fn(async ({ scenarioIds }: { scenarioIds: readonly string[] }) => ({ passed: true as const, scenarioIds }));
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration" });

    await expect(flow.merge({
      epicId: "E-1",
      story: { ...story, scenarioIds: [] },
      integratedStories: [],
    })).resolves.toEqual({
      kind: "verification_failed",
      integrationBranch: "epic/E-1",
      scenarioIds: [],
      reason: "missing scenario mapping for Story S-M2-05-integration",
    });
    expect(verify).not.toHaveBeenCalled();
    expect(calls.some(({ args }) => args[0] === "merge")).toBe(false);
  });

  it("opens the Story's review request after the rebase and before anything is merged", async () => {
    const order: string[] = [];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      order.push(args.join(" "));
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      return "";
    }) };
    const verify = vi.fn(async ({ scenarioIds }: { scenarioIds: readonly string[] }) => {
      order.push("verify");
      return { passed: true as const, scenarioIds };
    });
    const publish = vi.fn(async () => {
      order.push("publish");
      return { mrUrl: "https://example.test/pull/9" };
    });
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [], publish })).resolves.toMatchObject({
      kind: "merged",
      mrUrl: "https://example.test/pull/9",
    });
    expect(publish).toHaveBeenCalledWith(story);
    const at = (step: string) => order.findIndex((entry) => entry.startsWith(step));
    expect(at("rebase")).toBeLessThan(at("publish"));
    expect(at("publish")).toBeLessThan(at("verify"));
    expect(at("verify")).toBeLessThan(at("merge --ff-only"));
  });

  it("re-verifies the rebased Story tree, not the Epic head it is about to land on", async () => {
    const order: string[] = [];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      order.push(`${cwd}:${args.join(" ")}`);
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args.join(" ") === "rev-parse HEAD") return cwd === "story" ? "cafe1\n" : "beef2\n";
      if (args[0] === "diff" && args[1] === "--name-only") return "src/vcs/merge-flow.ts\n";
      return "";
    }) };
    let seen: { candidate: { cwd: string; revision: string }; base: { cwd: string; revision: string }; changedPaths: readonly string[] } | undefined;
    const verify = vi.fn(async (request: typeof seen & object) => {
      order.push("verify");
      seen = request;
      return { passed: true as const, scenarioIds: story.scenarioIds };
    });
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toMatchObject({ kind: "merged" });
    // The integration worktree still holds the Epic head at this point, so
    // checks run there answer whether the Epic head is green - a question the
    // Story cannot change however many rounds it spends on it.
    expect(seen?.candidate).toEqual({ cwd: "story", revision: "cafe1" });
    expect(seen?.base).toEqual({ cwd: "integration", revision: "beef2" });
    expect(seen?.changedPaths).toEqual(["src/vcs/merge-flow.ts"]);
    const at = (step: string) => order.findIndex((entry) => entry.includes(step));
    expect(at("rebase")).toBeLessThan(at("verify"));
    expect(at("verify")).toBeLessThan(at("merge --ff-only"));
  });

  it("refuses the merge when the Epic head moved under the re-verification", async () => {
    const baseRevisions = ["beef2", "d00d3"];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args.join(" ") === "rev-parse HEAD") {
        return cwd === "story" ? "cafe1\n" : `${baseRevisions.shift() ?? "d00d3"}\n`;
      }
      return "";
    }) };
    const verify = vi.fn(async ({ scenarioIds }: { scenarioIds: readonly string[] }) => ({ passed: true as const, scenarioIds }));
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration" });

    const result = await flow.merge({ epicId: "E-1", story, integratedStories: [] });
    expect(result.kind).toBe("verification_failed");
    expect((result as { reason?: string }).reason).toContain("Epic head moved");
    expect(git.run.mock.calls.some(([, args]) => args[0] === "merge")).toBe(false);
  });

  it("carries the attribution and the failing test names on a refusal", async () => {
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args.join(" ") === "rev-parse HEAD") return cwd === "story" ? "cafe1\n" : "beef2\n";
      return "";
    }) };
    const verify = vi.fn(async ({ scenarioIds }: { scenarioIds: readonly string[] }) => ({
      passed: false as const,
      scenarioIds,
      reasons: ["npm test fails with this Story on top of beef2"],
      attribution: "story_regression" as const,
      failures: ["src/coupon.test.ts > applies the discount"],
      failedChecks: ["npm test"],
    }));
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toMatchObject({
      kind: "verification_failed",
      attribution: "story_regression",
      failures: ["src/coupon.test.ts > applies the discount"],
      failedChecks: ["npm test"],
      baseRevision: "beef2",
      candidateRevision: "cafe1",
    });
  });
});
