import { describe, expect, it, vi } from "vitest";
import type { StorySnapshot } from "../orchestrator/story-execution-store.js";
import { GitMrStoryDelivery } from "./story-delivery.js";

const story: StorySnapshot = {
  id: "S-EPIC1-01", epicId: "EPIC1", notionPageId: "page-1", title: "Deliver safely",
  requirement: "Publish a reviewed Story branch.", repo: "example/repo", branch: "story/epic1-01",
  targetBranch: "main", state: "MERGE", phase: "MERGE", innerLoopRounds: 1,
  phaseReentries: 0, regressionReopens: 0,
  lastHumanActionAt: null, stopReason: null, mrUrl: null, resumeState: null,
};

describe("GitMrStoryDelivery", () => {
  it("S-M2-06-epicmr stacks a Story's draft merge request onto the Epic branch, never onto main", async () => {
    const calls: string[][] = [];
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "branch") return "story/epic1-01\n";
      if (args[0] === "rev-list") return "3\n";
      return "";
    }) };
    const create = vi.fn(async () => ({ url: "https://github.com/example/repo/pull/7", provider: "github" as const }));
    const findOpen = vi.fn(async () => null);
    const delivery = new GitMrStoryDelivery({ create, findOpen }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story, mergeArtifact: "All scenarios passed." }))
      .resolves.toEqual({ mrUrl: "https://github.com/example/repo/pull/7" });
    expect(calls).toEqual([
      ["branch", "--show-current"],
      ["status", "--porcelain"],
      ["push", "--set-upstream", "origin", "story/epic1-01"],
      ["rev-list", "--count", "origin/epic/EPIC1..story/epic1-01"],
    ]);
    expect(findOpen).toHaveBeenCalledWith({ repository: "example/repo", sourceBranch: "story/epic1-01", targetBranch: "epic/EPIC1" });
    expect(create).toHaveBeenCalledWith({
      repository: "example/repo",
      sourceBranch: "story/epic1-01",
      targetBranch: "epic/EPIC1",
      title: "[S-EPIC1-01] Deliver safely",
      body: "All scenarios passed.",
      draft: true,
    });
  });

  it("does not publish when the worktree is dirty", async () => {
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => args[0] === "branch"
      ? "story/epic1-01\n" : " M src/file.ts\n") };
    const delivery = new GitMrStoryDelivery({ create: vi.fn(), findOpen: async () => null }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story, mergeArtifact: "Report" })).rejects.toThrow(/uncommitted/);
    expect(git.run).toHaveBeenCalledTimes(2);
  });
});

describe("GitMrStoryDelivery for a Story that no Epic MR covers", () => {
  const standalone: StorySnapshot = (() => {
    const snapshot = { ...story };
    delete snapshot.epicId;
    return snapshot;
  })();

  it("creates the Story merge request itself so a single-Story delivery still reaches a human", async () => {
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => (args[0] === "branch" ? "story/epic1-01\n" : "")) };
    const create = vi.fn(async () => ({ url: "https://example.test/pull/9", provider: "github" as const }));
    const delivery = new GitMrStoryDelivery({ create, findOpen: async () => null }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story: standalone, mergeArtifact: "All scenarios passed." }))
      .resolves.toEqual({ mrUrl: "https://example.test/pull/9" });
    expect(create).toHaveBeenCalledWith({
      repository: "example/repo",
      sourceBranch: "story/epic1-01",
      targetBranch: "main",
      title: "[S-EPIC1-01] Deliver safely",
      body: "All scenarios passed.",
    });
  });

  it("never opens a merge request before the branch is published", async () => {
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "branch") return "story/epic1-01\n";
      if (args[0] === "push") throw new Error("remote rejected");
      return "";
    }) };
    const create = vi.fn();
    const delivery = new GitMrStoryDelivery({ create, findOpen: async () => null }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story: standalone, mergeArtifact: "Report" })).rejects.toThrow(/remote rejected/);
    expect(create).not.toHaveBeenCalled();
  });

  it("reuses the review request a refused first attempt left open instead of opening another", async () => {
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => (args[0] === "branch" ? "story/epic1-01\n" : "")) };
    const create = vi.fn();
    const findOpen = vi.fn(async () => "https://github.com/example/repo/pull/7");
    const delivery = new GitMrStoryDelivery({ create, findOpen }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story, mergeArtifact: "Again." }))
      .resolves.toEqual({ mrUrl: "https://github.com/example/repo/pull/7" });
    expect(create).not.toHaveBeenCalled();
  });

  it("opens nothing for a branch the target branch already contains", async () => {
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "branch") return "story/epic1-01\n";
      if (args[0] === "rev-list") return "0\n";
      return "";
    }) };
    const create = vi.fn();
    const delivery = new GitMrStoryDelivery({ create, findOpen: async () => null }, { worktreePath: "D:/worktree", git });

    await expect(delivery.deliver({ story, mergeArtifact: "Already on the Epic head." })).resolves.toEqual({ mrUrl: null });
    expect(create).not.toHaveBeenCalled();
  });
});
