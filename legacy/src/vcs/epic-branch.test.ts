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

  it("keeps going when the other caller cut the branch between the check and the create", async () => {
    // The plan approval and the first Story's dispatch both publish the branch.
    let created = false;
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "ls-remote") return "";
      if (args[0] === "rev-parse") {
        if (!created) throw new Error("no such ref");
        return "abc\n";
      }
      if (args[0] === "branch") {
        created = true;
        throw new Error("fatal: a branch named 'epic/E-1' already exists");
      }
      return "";
    }) };
    await expect(publishEpicBranch({ git, repositoryPath: "repo", epicId: "E-1" }))
      .resolves.toEqual({ branch: "epic/E-1", pushed: true });
  });

  it("still fails when the branch is missing after the create failed", async () => {
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "ls-remote") return "";
      if (args[0] === "rev-parse") throw new Error("no such ref");
      if (args[0] === "branch") throw new Error("fatal: not a valid object name");
      return "";
    }) };
    await expect(publishEpicBranch({ git, repositoryPath: "repo", epicId: "E-1" }))
      .rejects.toThrow(/not a valid object name/);
  });

  it("accepts a push that lost the race to the same commit", async () => {
    let published = false;
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "ls-remote") return published ? "abc\trefs/heads/epic/E-1\n" : "";
      if (args[0] === "rev-parse") return "abc\n";
      if (args[0] === "push") {
        published = true;
        throw new Error("failed to push some refs");
      }
      return "";
    }) };
    await expect(publishEpicBranch({ git, repositoryPath: "repo", epicId: "E-1" }))
      .resolves.toEqual({ branch: "epic/E-1", pushed: false });
  });

  it("reports a push that failed against a remote holding a different commit", async () => {
    // Nothing on origin on the way in, something else on it by the time the
    // push fails: that is a diverged remote, and it has to stay loud.
    let seen = false;
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "ls-remote") {
        if (!seen) { seen = true; return ""; }
        return "def\trefs/heads/epic/E-1\n";
      }
      if (args[0] === "rev-parse") return "abc\n";
      if (args[0] === "push") throw new Error("non-fast-forward");
      return "";
    }) };
    await expect(publishEpicBranch({ git, repositoryPath: "repo", epicId: "E-1" }))
      .rejects.toThrow(/non-fast-forward/);
  });

  it("refuses an Epic id that cannot be a branch name", async () => {
    const { git } = fakeGit(false, false);
    await expect(publishEpicBranch({ git, repositoryPath: "repo", epicId: "E 1" })).rejects.toThrow(/branch name/);
  });
});
