import { describe, expect, it, vi } from "vitest";
import type { StorySnapshot } from "../orchestrator/story-execution-store.js";
import { GitMrStoryDelivery } from "./story-delivery.js";

const story: StorySnapshot = {
  id: "S-EPIC1-01", epicId: "EPIC1", notionPageId: "page-1", title: "Deliver safely",
  requirement: "Publish a reviewed Story branch.", repo: "example/repo", branch: "story/epic1-01",
  targetBranch: "main", state: "MERGE", phase: "MERGE", innerLoopRounds: 1,
  phaseReentries: 0, stopReason: null, mrUrl: null, resumeState: null,
};

function gitPort(push: () => Promise<string> = async () => "") {
  return { run: vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === "branch") return "story/epic1-01\n";
    if (args[0] === "status") return "";
    if (args[0] === "merge-base") return "base-revision\n";
    if (args[0] === "rev-parse") return "story-revision\n";
    if (args[0] === "diff") return "M\0src/vcs/story-delivery.ts\0A\0docs/plan/tasks.md\0";
    return push();
  }) };
}

describe("S-M2-07-live actual footprint recorded by the live delivery path", () => {
  it("records the directories the Story branch actually changed against its target branch", async () => {
    const footprints = { capture: vi.fn(async () => undefined), apply: vi.fn(async () => undefined) };
    const git = gitPort();
    const delivery = new GitMrStoryDelivery({ create: vi.fn() }, {
      worktreePath: "D:/worktree",
      targetBranch: "main",
      git,
      actualFootprints: footprints,
    });

    await delivery.deliver({ story, mergeArtifact: "All scenarios passed." });

    expect(git.run).toHaveBeenCalledWith("D:/worktree", ["merge-base", "origin/main", "story/epic1-01"]);
    expect(footprints.capture).toHaveBeenCalledWith({
      storyId: "S-EPIC1-01",
      integrationBranch: "main",
      baseRevision: "base-revision",
      storyRevision: "story-revision",
      actualFootprint: ["docs/plan", "src/vcs"],
    });
    expect(footprints.apply).toHaveBeenCalledWith("S-EPIC1-01");
  });

  it("records nothing when publishing the branch fails", async () => {
    const footprints = { capture: vi.fn(async () => undefined), apply: vi.fn(async () => undefined) };
    const delivery = new GitMrStoryDelivery({ create: vi.fn() }, {
      worktreePath: "D:/worktree",
      targetBranch: "main",
      git: gitPort(async () => { throw new Error("remote rejected"); }),
      actualFootprints: footprints,
    });

    await expect(delivery.deliver({ story, mergeArtifact: "Report" })).rejects.toThrow(/remote rejected/);
    expect(footprints.capture).not.toHaveBeenCalled();
    expect(footprints.apply).not.toHaveBeenCalled();
  });
});
