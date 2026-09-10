import { describe, expect, it, vi } from "vitest";
import { publishEpicBranch } from "./epic-branch.js";

function fakeGit(remoteHas: boolean, localHas: boolean) {
  const calls: string[][] = [];
  const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "ls-remote") return remoteHas ? "abc\trefs/heads/epic/E-1\n" : "";
    if (args[0] === "rev-parse") {
      if (!localHas) throw new Error("no such ref");
      return "abc";
    }
    return "";
  }) };
  return { git, calls };
}

describe("publishEpicBranch", () => {
  it("cuts the branch from origin main and pushes it when nobody has it yet", async () => {
    const { git, calls } = fakeGit(false, false);
    const result = await publishEpicBranch({ git, repositoryPath: "repo", epicId: "E-1" });
    expect(result).toEqual({ branch: "epic/E-1", pushed: true });
    expect(calls).toContainEqual(["branch", "epic/E-1", "origin/main"]);
    expect(calls).toContainEqual(["push", "--set-upstream", "origin", "epic/E-1"]);
  });

  it("pushes an existing local branch without recreating it", async () => {
    const { git, calls } = fakeGit(false, true);
    await publishEpicBranch({ git, repositoryPath: "repo", epicId: "E-1" });
    expect(calls.some((args) => args[0] === "branch")).toBe(false);
    expect(calls).toContainEqual(["push", "--set-upstream", "origin", "epic/E-1"]);
  });

  it("leaves a branch origin already has alone and only fetches it", async () => {
    const { git, calls } = fakeGit(true, true);
    const result = await publishEpicBranch({ git, repositoryPath: "repo", epicId: "E-1" });
    expect(result.pushed).toBe(false);
    expect(calls.some((args) => args[0] === "push")).toBe(false);
    expect(calls).toContainEqual(["fetch", "origin", "epic/E-1:refs/remotes/origin/epic/E-1"]);
  });

  it("refuses an Epic id that cannot be a branch name", async () => {
    const { git } = fakeGit(false, false);
    await expect(publishEpicBranch({ git, repositoryPath: "repo", epicId: "E 1" })).rejects.toThrow(/branch name/);
  });
});
