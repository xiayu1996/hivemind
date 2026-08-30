import { describe, expect, it, vi } from "vitest";
import type { StorySnapshot } from "../orchestrator/story-execution-store.js";
import { GitMrStoryDelivery } from "./story-delivery.js";

const story: StorySnapshot = {
  id: "S-EPIC1-01",
  notionPageId: "page-1",
  title: "Deliver safely",
  requirement: "Publish a reviewed Story branch.",
  repo: "example/repo",
  branch: "story/epic1-01",
  targetBranch: "main",
  state: "MERGE",
  phase: "MERGE",
  innerLoopRounds: 1,
  phaseReentries: 0,
  stopReason: null,
  mrUrl: null,
  resumeState: null,
};

describe("GitMrStoryDelivery", () => {
  it("checks branch and cleanliness, publishes, then creates the MR", async () => {
    const calls: string[][] = [];
    const git = {
      run: vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "branch") return "story/epic1-01\n";
        return "";
      }),
    };
    const create = vi.fn(async () => ({ url: "https://github.com/example/repo/pull/7", provider: "github" as const }));
    const delivery = new GitMrStoryDelivery({ create }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story, mergeArtifact: "All scenarios passed." })).resolves.toEqual({
      mrUrl: "https://github.com/example/repo/pull/7",
    });
    expect(calls).toEqual([
      ["branch", "--show-current"],
      ["status", "--porcelain"],
      ["push", "--set-upstream", "origin", "story/epic1-01"],
    ]);
    expect(create).toHaveBeenCalledWith({
      repository: "example/repo",
      sourceBranch: "story/epic1-01",
      targetBranch: "main",
      title: "[S-EPIC1-01] Deliver safely",
      body: "All scenarios passed.",
    });
  });

  it("does not publish when the worktree is dirty", async () => {
    const git = {
      run: vi.fn(async (_cwd: string, args: string[]) => args[0] === "branch"
        ? "story/epic1-01\n"
        : " M src/file.ts\n"),
    };
    const create = vi.fn();
    const delivery = new GitMrStoryDelivery({ create }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story, mergeArtifact: "Report" })).rejects.toThrow(/uncommitted/);
    expect(create).not.toHaveBeenCalled();
    expect(git.run).toHaveBeenCalledTimes(2);
  });
});
