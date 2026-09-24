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

const consoleStory = {
  id: "S-E-01",
  branch: "story/s-e-01",
  predictedFootprint: ["src/console"],
  scenarioIds: ["S-E-01-a"],
};

const passingVerifier = async ({ scenarioIds }: { scenarioIds: readonly string[] }) => ({ passed: true as const, scenarioIds });

/** A tree that merges cleanly and produces the given name-status diff. */
function footprintGit(nameStatus: string) {
  return { run: vi.fn(async (cwd: string, args: string[]) => {
    const command = args.join(" ");
    if (command === "branch --show-current") return cwd === "story" ? consoleStory.branch : "epic/E-1";
    if (command === "rev-parse HEAD") return cwd === "story" ? "candidate\n" : "base\n";
    if (args[0] === "diff" && args[1] === "--name-status") return nameStatus;
    return "";
  }) };
}

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

  /** A git whose origin holds `remoteAhead` commits this host does not, and
   * whose local branch is `localAhead` commits ahead of origin. */
  function divergedGit(localAhead: number, remoteAhead: number, mergeFails = false) {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      const command = args.join(" ");
      if (command === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args[0] === "rev-list") return `${localAhead}\t${remoteAhead}\n`;
      if (mergeFails && command === "merge --no-edit refs/remotes/origin/epic/E-1") {
        throw new Error("CONFLICT (content): Merge conflict in src/console/server.ts");
      }
      return "";
    }) };
    return { git, calls };
  }

  it("takes the Epic head origin holds before it measures anything against it", async () => {
    const { git, calls } = divergedGit(0, 3);
    const flow = new EpicMergeFlow(git, passingVerifier, { storyWorktree: "story", integrationWorktree: "integration" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toMatchObject({ kind: "merged" });
    const commands = calls.map(({ args }) => args.join(" "));
    expect(commands).toContain("fetch origin +refs/heads/epic/E-1:refs/remotes/origin/epic/E-1");
    expect(commands.indexOf("merge --ff-only refs/remotes/origin/epic/E-1")).toBeLessThan(commands.indexOf("rebase epic/E-1"));
  });

  it("merges a diverged Epic head in rather than pushing over another host's Story", async () => {
    const { git, calls } = divergedGit(2, 1);
    const flow = new EpicMergeFlow(git, passingVerifier, { storyWorktree: "story", integrationWorktree: "integration" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toMatchObject({ kind: "merged" });
    const commands = calls.map(({ args }) => args.join(" "));
    expect(commands).toContain("merge --no-edit refs/remotes/origin/epic/E-1");
    expect(commands.some((command) => command.includes("--force"))).toBe(false);
  });

  it("leaves an unmergeable Epic head to a person instead of an unlandable run", async () => {
    const { git, calls } = divergedGit(2, 1, true);
    const flow = new EpicMergeFlow(git, passingVerifier, { storyWorktree: "story", integrationWorktree: "integration" });

    const result = await flow.merge({ epicId: "E-1", story, integratedStories: [] });
    expect(result).toMatchObject({ kind: "verification_failed", attribution: "environment" });
    expect((result as { reason?: string }).reason).toContain("diverged from this host");
    expect(calls.map(({ args }) => args.join(" "))).toContain("merge --abort");
    expect(calls.some(({ args }) => args[0] === "rebase")).toBe(false);
  });

  it("creates the Epic branch on origin when there is nothing there to take", async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      calls.push({ cwd, args });
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args[0] === "ls-remote") throw new Error("exit status 2");
      return "";
    }) };
    const flow = new EpicMergeFlow(git, passingVerifier, { storyWorktree: "story", integrationWorktree: "integration" });

    await expect(flow.merge({ epicId: "E-1", story, integratedStories: [] })).resolves.toMatchObject({ kind: "merged" });
    expect(calls.some(({ args }) => args[0] === "fetch")).toBe(false);
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
    // The conflict is read out of the worktree and then the worktree is handed
    // back on its branch. Left mid-rebase it sits detached, and the next
    // dispatch of this card refuses to start in it.
    const inspected = calls.findIndex(({ args }) => args.join(" ") === "diff --name-only --diff-filter=U");
    const abandoned = calls.findIndex(({ args }) => args.join(" ") === "rebase --abort");
    expect(abandoned).toBeGreaterThan(inspected);
    expect(calls[abandoned]?.cwd).toBe("story");
  });

  it("says the worktree still needs a hand when the rebase cannot be abandoned", async () => {
    const git = { run: vi.fn(async (cwd: string, args: string[]) => {
      if (args.join(" ") === "branch --show-current") return cwd === "story" ? story.branch : "epic/E-1";
      if (args.join(" ") === "rebase epic/E-1") throw new Error("rebase failed");
      if (args.join(" ") === "diff --name-only --diff-filter=U") return "src/vcs/merge-flow.ts\n";
      if (args.join(" ") === "rebase --abort") throw new Error("no rebase in progress");
      return "";
    }) };
    const flow = new EpicMergeFlow(git, vi.fn(), { storyWorktree: "story", integrationWorktree: "integration" });

    const result = await flow.merge({ epicId: "E-1", story, integratedStories: [] });
    expect(result).toMatchObject({ kind: "conflict", files: ["src/vcs/merge-flow.ts"] });
    expect((result as { reason: string }).reason).toContain("still mid-rebase");
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

  it("reports the directories a Story worked in without predicting them", async () => {
    const overreaches: unknown[] = [];
    const flow = new EpicMergeFlow(footprintGit("M\u0000src/console/server.ts\u0000M\u0000src/verify/executor.ts\u0000M\u0000vitest.config.ts\u0000"), passingVerifier, {
      storyWorktree: "story",
      integrationWorktree: "integration",
      onFootprintOverreach: async (overreach) => { overreaches.push(overreach); },
    });

    await flow.merge({ epicId: "E-1", story: consoleStory, integratedStories: [] });

    expect(overreaches).toEqual([{
      storyId: consoleStory.id,
      predicted: ["src/console"],
      actual: [".", "src/console", "src/verify"],
      unpredicted: [".", "src/verify"],
    }]);
  });

  it("says nothing when the diff stayed inside the prediction", async () => {
    const overreaches: unknown[] = [];
    const flow = new EpicMergeFlow(footprintGit("M\u0000src/console/server.ts\u0000"), passingVerifier, {
      storyWorktree: "story",
      integrationWorktree: "integration",
      onFootprintOverreach: async (overreach) => { overreaches.push(overreach); },
    });

    await flow.merge({ epicId: "E-1", story: consoleStory, integratedStories: [] });

    expect(overreaches).toEqual([]);
  });
});
