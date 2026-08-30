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
    const verify = vi.fn(async (scenarioIds: readonly string[]) => ({ passed: true as const, scenarioIds }));
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration", mainBranch: "main" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toEqual({
      kind: "merged",
      integrationBranch: "epic/E-1",
      scenarioIds: ["S-M2-05-integration"],
    });
    expect(calls).toEqual(expect.arrayContaining([
      { cwd: "integration", args: ["switch", "-c", "epic/E-1", "main"] },
      { cwd: "story", args: ["rebase", "epic/E-1"] },
      { cwd: "integration", args: ["merge", "--ff-only", story.branch] },
    ]));
    expect(calls.some(({ args }) => args.includes("push") || args.includes("main") && args[0] === "merge")).toBe(false);
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
    const verify = vi.fn(async (scenarioIds: readonly string[]) => ({ passed: true as const, scenarioIds }));
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
});
