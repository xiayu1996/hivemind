import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree, locateWorktree, quarantineWorktree, retireWorktree, worktreeLayout } from "./worktree.js";

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

  it("gives back a retired worktree's commits when the card is reopened", async () => {
    const repo = await repository();
    const root = await mkdtemp(join(tmpdir(), "hm-worktree-retire-"));
    const layout = worktreeLayout(root);
    const input = {
      repositoryPath: repo,
      repositoryId: "sample",
      cardId: "story-4",
      branch: "story/sample-4",
      startPoint: "main",
    };
    const first = await createWorktree(input, layout);
    await writeFile(join(first.worktreePath, "work.txt"), "delivered work\n", "utf8");
    execFileSync("git", ["add", "work.txt"], { cwd: first.worktreePath });
    execFileSync("git", ["commit", "-m", "story work"], { cwd: first.worktreePath });

    expect(await retireWorktree(repo, first.worktreePath)).toBe(true);
    await expect(stat(first.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });

    // A delivered card that regression reopens is dispatched again, and what
    // it gets back has to be its own branch, not a fresh one off main.
    const again = await createWorktree(input, layout);
    expect((await readFile(join(again.worktreePath, "work.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("delivered work\n");
  });

  it("puts a worktree back after its directory left without git being told", async () => {
    const repo = await repository();
    const root = await mkdtemp(join(tmpdir(), "hm-worktree-restore-"));
    const layout = worktreeLayout(root);
    const input = {
      repositoryPath: repo,
      repositoryId: "sample",
      cardId: "story-3",
      branch: "story/sample-3",
      startPoint: "main",
    };
    const first = await createWorktree(input, layout);
    await writeFile(join(first.worktreePath, "work.txt"), "committed work\n", "utf8");
    execFileSync("git", ["add", "work.txt"], { cwd: first.worktreePath });
    execFileSync("git", ["commit", "-m", "story work"], { cwd: first.worktreePath });
    // Whoever removed it -- an operator clearing disk, a half-finished rename,
    // a machine that died -- git still holds the registration, and without
    // clearing it the card's own branch has nowhere left to be checked out.
    await rm(first.worktreePath, { recursive: true, force: true });

    const again = await createWorktree(input, layout);

    expect(again.worktreePath).toBe(first.worktreePath);
    expect(await readFile(join(again.worktreePath, "work.txt"), "utf8")).toBe("committed work\n");
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: again.worktreePath, encoding: "utf8" }).trim())
      .toBe("story/sample-3");
  });

  it("leaves another card's worktree alone while restoring its own", async () => {
    const repo = await repository();
    const root = await mkdtemp(join(tmpdir(), "hm-worktree-neighbour-"));
    const layout = worktreeLayout(root);
    const neighbour = await createWorktree({
      repositoryPath: repo,
      repositoryId: "sample",
      cardId: "story-4",
      branch: "story/sample-4",
      startPoint: "main",
    }, layout);
    const lost = await createWorktree({
      repositoryPath: repo,
      repositoryId: "sample",
      cardId: "story-5",
      branch: "story/sample-5",
      startPoint: "main",
    }, layout);
    await rm(lost.worktreePath, { recursive: true, force: true });

    await createWorktree({
      repositoryPath: repo,
      repositoryId: "sample",
      cardId: "story-5",
      branch: "story/sample-5",
      startPoint: "main",
    }, layout);

    expect((await stat(neighbour.worktreePath)).isDirectory()).toBe(true);
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }))
      .toContain(neighbour.worktreePath);
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
