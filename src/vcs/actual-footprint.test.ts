import { describe, expect, it, vi } from "vitest";
import { EpicMergeFlow } from "./merge-flow.js";

const story = {
  id: "S-M2-07-record",
  branch: "story/s-m2-07-record",
  predictedFootprint: ["src/vcs"],
  scenarioIds: ["S-M2-07-record"],
};

describe("S-M2-07-record actual footprint capture", () => {
  it("persists normalized actual directories before the fast-forward and applies them only after it", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const captures: unknown[] = [];
    const store = {
      capture: vi.fn(async (capture: unknown) => { captures.push(capture); }),
      apply: vi.fn(async () => undefined),
    };
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args.join(" ") === "rev-parse HEAD") return cwd === "integration" ? "base-revision\n" : "story-revision\n";
      if (args[0] === "diff") return "M\0src/vcs/merge-flow.ts\0R100\0src/old/file.ts\0src/console/server.ts\0D\0README.md\0";
      return "";
    }) };
    const flow = new EpicMergeFlow(git, async (scenarioIds) => ({ passed: true, scenarioIds }), {
      storyWorktree: "story",
      integrationWorktree: "integration",
      actualFootprints: store,
    });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toMatchObject({ kind: "merged" });
    expect(captures).toEqual([{
      storyId: story.id,
      integrationBranch: "epic/E-1",
      baseRevision: "base-revision",
      storyRevision: "story-revision",
      actualFootprint: [".", "src/console", "src/old", "src/vcs"],
    }]);
    const fastForward = git.run.mock.invocationCallOrder[calls.findIndex(({ args }) => args[0] === "merge")];
    expect(store.capture.mock.invocationCallOrder[0]).toBeLessThan(fastForward);
    expect(store.apply.mock.invocationCallOrder[0]).toBeGreaterThan(fastForward);
    expect(store.apply).toHaveBeenCalledWith(story.id);
  });
});
