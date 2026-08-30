import { describe, expect, it, vi } from "vitest";
import { EpicMergeFlow } from "./merge-flow.js";

const story = { id: "S-M2-05-integration", branch: "story/s-m2-05-integration", predictedFootprint: ["src/vcs"] };

describe("EpicMergeFlow", () => {
  it("S-M2-05-integration creates an Epic branch from main and merges a verified Story without touching main", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args[0] === "show-ref") throw new Error("missing ref");
      return "";
    }) };
    const verify = vi.fn(async (scenarioIds: readonly string[]) => ({ passed: true as const, scenarioIds }));
    const flow = new EpicMergeFlow(git, verify, { storyWorktree: "story", integrationWorktree: "integration", mainBranch: "main" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toEqual({
      kind: "merged",
      integrationBranch: "epic/E-1",
      scenarioIds: [],
    });
    expect(calls).toEqual(expect.arrayContaining([
      { cwd: "integration", args: ["switch", "-c", "epic/E-1", "main"] },
      { cwd: "story", args: ["rebase", "epic/E-1"] },
      { cwd: "integration", args: ["merge", "--ff-only", story.branch] },
    ]));
    expect(calls.some(({ args }) => args.includes("push") || args.includes("main") && args[0] === "merge")).toBe(false);
  });
});
