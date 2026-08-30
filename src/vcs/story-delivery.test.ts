import { describe, expect, it, vi } from "vitest";
import type { StorySnapshot } from "../orchestrator/story-execution-store.js";
import { GitMrStoryDelivery } from "./story-delivery.js";

const story: StorySnapshot = {
  id: "S-EPIC1-01", epicId: "EPIC1", notionPageId: "page-1", title: "Deliver safely",
  requirement: "Publish a reviewed Story branch.", repo: "example/repo", branch: "story/epic1-01",
  targetBranch: "main", state: "MERGE", phase: "MERGE", innerLoopRounds: 1,
  phaseReentries: 0, stopReason: null, mrUrl: null, resumeState: null,
};

describe("GitMrStoryDelivery", () => {
  it("S-M2-06-epicmr publishes a clean Story branch but creates no Story-level merge request", async () => {
    const calls: string[][] = [];
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      return args[0] === "branch" ? "story/epic1-01\n" : "";
    }) };
    const create = vi.fn();
    const delivery = new GitMrStoryDelivery({ create }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story, mergeArtifact: "All scenarios passed." })).resolves.toEqual({ mrUrl: null });
    expect(calls).toEqual([
      ["branch", "--show-current"],
      ["status", "--porcelain"],
      ["push", "--set-upstream", "origin", "story/epic1-01"],
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not publish when the worktree is dirty", async () => {
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => args[0] === "branch"
      ? "story/epic1-01\n" : " M src/file.ts\n") };
    const delivery = new GitMrStoryDelivery({ create: vi.fn() }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story, mergeArtifact: "Report" })).rejects.toThrow(/uncommitted/);
    expect(git.run).toHaveBeenCalledTimes(2);
  });
});
