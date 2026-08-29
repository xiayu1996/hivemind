import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree, locateWorktree, quarantineWorktree, worktreeLayout } from "./worktree.js";

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hm-worktree-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Hivemind Tests"], { cwd: root });
  execFileSync("git", ["config", "user.email", "tests@invalid.local"], { cwd: root });
  await writeFile(join(root, "README.md"), "base\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

describe("worktree layout", () => {
  it("uses stable repository and card paths", () => {
    const layout = worktreeLayout("C:/hm-root");
    expect(locateWorktree("repo", "card-1", layout)).toEqual({
      worktreePath: join(layout.worktrees, "repo", "card-1"),
      quarantineRoot: join(layout.quarantine, "repo"),
      evidencePath: join(layout.evidence, "repo", "card-1"),
    });
  });

  it("rejects path traversal segments", () => {
    expect(() => locateWorktree("../repo", "card", worktreeLayout("C:/hm-root"))).toThrow(/safe path/);
  });
});

describe("worktree lifecycle", () => {
  it("creates an isolated branch and evidence directory", async () => {
    const repo = await repository();
    const root = await mkdtemp(join(tmpdir(), "hm-worktree-root-"));
    const layout = worktreeLayout(root);
    const location = await createWorktree({
      repositoryPath: repo,
      repositoryId: "sample",
      cardId: "story-1",
      branch: "story/sample-1",
      startPoint: "main",
    }, layout);

    expect((await readFile(join(location.worktreePath, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("base\n");
    expect((await stat(location.evidencePath)).isDirectory()).toBe(true);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: location.worktreePath, encoding: "utf8" }).trim())
      .toBe("story/sample-1");
  });

  it("moves suspect data to recoverable quarantine and rejects unmanaged paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "hm-worktree-quarantine-"));
    const layout = worktreeLayout(root);
    const location = locateWorktree("sample", "story-2", layout);
    await mkdir(location.worktreePath, { recursive: true });
    await writeFile(join(location.worktreePath, "evidence.txt"), "keep", "utf8");

    const quarantined = await quarantineWorktree(location.worktreePath, "tree pin mismatch", layout, () => 123);
    expect(await readFile(join(quarantined, "evidence.txt"), "utf8")).toBe("keep");
    await expect(quarantineWorktree(root, "bad", layout)).rejects.toThrow(/outside/);
  });
});
