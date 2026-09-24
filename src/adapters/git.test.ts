import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandResult, Git, RepositoryConfig, RunCommand, RunCommandOptions } from "../ports.ts";
import { createGit, redactCredentials } from "./git.ts";
import { baseEnvironment, runCommand } from "./process.ts";

let root: string;
let env: Record<string, string>;
let workRoot: string;
let originUrl: string;
let seed: string;
let git: Git;

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd, env });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}

async function write(cwd: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), content);
}

async function commitFile(cwd: string, path: string, content: string): Promise<string> {
  await write(cwd, path, content);
  await sh(cwd, "add", "--", path);
  await sh(cwd, "commit", "-q", "-m", `write ${path}`);
  return sh(cwd, "rev-parse", "HEAD");
}

/** Lands a commit on origin's main, as another writer would. */
async function landOnOrigin(path: string, content: string): Promise<string> {
  const sha = await commitFile(seed, path, content);
  await sh(seed, "push", "-q", "origin", "main");
  return sha;
}

const repo = (overrides: Partial<RepositoryConfig> = {}): RepositoryConfig => ({
  name: "widget", url: originUrl, defaultBranch: "main", push: true, recipe: "feature", ...overrides,
});

/** A synced checkout with branch `item` cut from origin's main and checked out in its own worktree. */
async function prepare(files: Record<string, string> = {}): Promise<{ checkout: string; worktree: string }> {
  for (const [path, content] of Object.entries(files)) await write(seed, path, content);
  if (Object.keys(files).length > 0) {
    await sh(seed, "add", "-A");
    await sh(seed, "commit", "-q", "-m", "base");
    await sh(seed, "push", "-q", "origin", "main");
  }
  const checkout = await git.sync(repo());
  await git.ensureBranch(checkout, "item", "origin/main");
  const worktree = join(workRoot, "worktrees", "item");
  await git.addWorktree(checkout, worktree, "item");
  return { checkout, worktree };
}

const result = (partial: Partial<CommandResult>): CommandResult => ({
  code: 0, signal: null, stdout: "", stderr: "", spawnError: null, timedOut: false, durationMs: 1, ...partial,
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(() => null, (error: unknown) => error);
  if (!(outcome instanceof Error)) throw new Error("expected the call to reject with an Error");
  return outcome;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hivemind-git-"));
  const config = join(root, "gitconfig");
  await writeFile(config, "[user]\n\tname = Hivemind Tests\n\temail = tests@example.invalid\n[init]\n\tdefaultBranch = main\n");
  // Hermetic: nothing from the developer's own git configuration (signing,
  // hooks, aliases) takes part.
  env = baseEnvironment({ HOME: root, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" });
  workRoot = join(root, "work");
  originUrl = join(root, "origin", "widget.git");
  seed = join(root, "seed");
  await mkdir(originUrl, { recursive: true });
  await mkdir(seed);
  await sh(root, "init", "-q", "--bare", "-b", "main", originUrl);
  await sh(root, "init", "-q", "-b", "main", seed);
  await commitFile(seed, "README.md", "seed\n");
  await sh(seed, "remote", "add", "origin", originUrl);
  await sh(seed, "push", "-q", "origin", "main");
  git = createGit({ workRoot, run: runCommand, env });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sync", () => {
  it("clones once into the service's own directory, detached, and leaves nothing half-made", async () => {
    const path = await git.sync(repo());

    expect(path).toBe(join(workRoot, "repos", "widget"));
    expect(await readdir(join(workRoot, "repos"))).toEqual(["widget"]);
    // Detached, which is what lets a worktree take any branch, the default one included.
    expect((await runCommand(["git", "symbolic-ref", "-q", "HEAD"], { cwd: path, env })).code).not.toBe(0);
    expect(await git.head(path)).toBe(await sh(seed, "rev-parse", "HEAD"));
  });

  it("fetches on every later call and moves the clean checkout to origin's head", async () => {
    const path = await git.sync(repo());
    const landed = await landOnOrigin("CHANGELOG.md", "one\n");
    expect(await git.resolve(path, "origin/main")).not.toBe(landed);

    expect(await git.sync(repo())).toBe(path);

    expect(await git.resolve(path, "origin/main")).toBe(landed);
    expect(await git.head(path)).toBe(landed);
  });

  it("settles two first syncs racing each other on one checkout", async () => {
    const [first, second] = await Promise.all([git.sync(repo()), git.sync(repo())]);
    expect(first).toBe(second);
    expect(await readdir(join(workRoot, "repos"))).toEqual(["widget"]);
  });

  it("will not adopt a directory that holds some other repository", async () => {
    const path = join(workRoot, "repos", "widget");
    await mkdir(path, { recursive: true });
    await sh(path, "init", "-q");
    await sh(path, "remote", "add", "origin", "https://example.invalid/other/widget.git");
    await expect(git.sync(repo())).rejects.toThrow(/is not the service's checkout/);
  });

  it("leaves nothing behind when the clone fails", async () => {
    await expect(git.sync(repo({ url: join(root, "missing.git") }))).rejects.toThrow(/git clone/);
    expect(await readdir(join(workRoot, "repos"))).toEqual([]);
  });

  it("refuses a remote URL that carries a password, before running anything and without repeating it", async () => {
    const calls: string[][] = [];
    const recording: RunCommand = async (argv) => {
      calls.push([...argv]);
      return result({});
    };
    const error = await rejection(
      createGit({ workRoot, run: recording, env }).sync(repo({ url: "https://user:hunter2@example.invalid/acme/widget.git" })),
    );
    expect(error.message).toMatch(/password/);
    expect(error.message).not.toContain("hunter2");
    expect(calls).toEqual([]);
  });

  it("cuts a token out of everything git reports about the remote", async () => {
    const url = "https://t0ken@example.invalid/acme/widget.git";
    const unreachable: RunCommand = async (argv) => argv.includes("clone")
      ? result({ code: 128, stderr: `fatal: unable to access '${url}/': Could not resolve host: example.invalid` })
      : result({});
    const error = await rejection(createGit({ workRoot, run: unreachable, env }).sync(repo({ url })));
    expect(error.message).toContain("https://***@example.invalid/acme/widget.git");
    expect(error.message).not.toContain("t0ken");
  });

  it("keeps its checkout when only the credential in the configured URL changed, and uses the new one", async () => {
    await mkdir(join(workRoot, "repos", "widget", ".git"), { recursive: true });
    const calls: string[][] = [];
    const rotated: RunCommand = async (argv) => {
      calls.push([...argv]);
      return argv.includes("get-url") ? result({ stdout: "https://old-t0ken@example.invalid/acme/widget.git\n" }) : result({});
    };
    const url = "https://new-t0ken@example.invalid/acme/widget.git";

    await createGit({ workRoot, run: rotated, env }).sync(repo({ url }));

    expect(calls).toContainEqual(["git", "remote", "set-url", "origin", url]);
    expect(calls.some((argv) => argv.includes("fetch"))).toBe(true);
  });

  it("refuses a name that cannot be a directory of its own", async () => {
    await expect(git.sync(repo({ name: "../escape" }))).rejects.toThrow(/cannot be used as a directory name/);
  });
});

describe("git environment and failures", () => {
  it("runs every command with no way to ask anyone for a credential", async () => {
    const seen: RunCommandOptions[] = [];
    const recording: RunCommand = async (_argv, options) => {
      seen.push(options);
      return result({ stdout: "abc\n" });
    };
    const headless = createGit({ workRoot, run: recording, env: { PATH: "/usr/bin", GIT_ASKPASS: "/usr/bin/helper" } });
    await headless.head("/srv/widget");
    expect(seen[0]?.env).toEqual({ PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" });
  });

  it("reports what git printed on stdout, where it says the consequential things", async () => {
    const error = await rejection(createGit({
      workRoot,
      run: async () => result({ code: 1, stdout: "nothing to commit, working tree clean\n" }),
      env,
    }).head("/srv/widget"));
    expect(error.message).toContain("git rev-parse --verify HEAD failed in /srv/widget: exited with code 1");
    expect(error.message).toContain("nothing to commit, working tree clean");
  });

  it("refuses an empty revision before git can read it as something else", async () => {
    const { checkout, worktree } = await prepare();
    await expect(git.resolve(checkout, "")).rejects.toThrow(/must be a sha or an existing ref/);
    await expect(git.ensureBranch(checkout, "other", "")).rejects.toThrow(/must be a sha or an existing ref/);
    await expect(git.changedPaths(worktree, "")).rejects.toThrow(/must be a sha or an existing ref/);
    await expect(git.rebase(worktree, "--onto")).rejects.toThrow(/must be a sha or an existing ref/);
  });

  it("redacts credentials in any URL form that carries them", () => {
    expect(redactCredentials("https://user:secret@github.com/acme/widget.git")).toBe("https://***@github.com/acme/widget.git");
    expect(redactCredentials("see 'https://ghp_x@github.com/a/b/' and https://github.com/c/d"))
      .toBe("see 'https://***@github.com/a/b/' and https://github.com/c/d");
    expect(redactCredentials("git@github.com:acme/widget.git")).toBe("git@github.com:acme/widget.git");
  });
});

describe("branches and worktrees", () => {
  it("resolves a ref to its commit, and anything missing to null", async () => {
    const path = await git.sync(repo());
    expect(await git.resolve(path, "origin/main")).toBe(await sh(seed, "rev-parse", "HEAD"));
    expect(await git.resolve(path, "no-such-branch")).toBeNull();
    expect(await git.resolve(path, "0123456789012345678901234567890123456789")).toBeNull();
  });

  it("creates a branch at its start point once, and never moves it afterwards", async () => {
    const path = await git.sync(repo());
    const start = await git.resolve(path, "origin/main");
    await git.ensureBranch(path, "integration", "origin/main");
    expect(await git.resolve(path, "integration")).toBe(start);

    await landOnOrigin("later.txt", "later\n");
    await git.sync(repo());
    await git.ensureBranch(path, "integration", "origin/main");
    expect(await git.resolve(path, "integration")).toBe(start);
  });

  it("checks the branch out at the path", async () => {
    const { worktree } = await prepare();
    expect(await sh(worktree, "branch", "--show-current")).toBe("item");
    expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("seed\n");
  });

  it("puts a worktree back after its directory left without git being told", async () => {
    const { checkout, worktree } = await prepare();
    await commitFile(worktree, "work.txt", "committed work\n");
    await rm(worktree, { recursive: true, force: true });

    await git.addWorktree(checkout, worktree, "item");

    expect(await readFile(join(worktree, "work.txt"), "utf8")).toBe("committed work\n");
    expect(await sh(worktree, "branch", "--show-current")).toBe("item");
  });

  it("clears the locked registration an interrupted add leaves behind", async () => {
    const { checkout, worktree } = await prepare();
    // What `git worktree add` leaves when it is killed halfway.
    await sh(checkout, "worktree", "lock", "--reason", "initializing", worktree);
    await rm(worktree, { recursive: true, force: true });

    await git.addWorktree(checkout, worktree, "item");

    expect(await sh(worktree, "branch", "--show-current")).toBe("item");
  });

  it("replaces a stale worktree still standing at the same path", async () => {
    const { checkout, worktree } = await prepare();
    await writeFile(join(worktree, "README.md"), "half-finished edit\n");
    await writeFile(join(worktree, "leftover.txt"), "from a crashed round\n");

    await git.addWorktree(checkout, worktree, "item");

    expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("seed\n");
    await expect(stat(join(worktree, "leftover.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves every other worktree alone while restoring one", async () => {
    const { checkout, worktree } = await prepare();
    await git.ensureBranch(checkout, "neighbour", "origin/main");
    const neighbour = join(workRoot, "worktrees", "neighbour");
    await git.addWorktree(checkout, neighbour, "neighbour");
    await rm(worktree, { recursive: true, force: true });

    await git.addWorktree(checkout, worktree, "item");

    expect((await stat(neighbour)).isDirectory()).toBe(true);
    expect(await sh(neighbour, "branch", "--show-current")).toBe("neighbour");
  });

  it("removes a worktree and its registration, keeps the branch, and does nothing the second time", async () => {
    const { checkout, worktree } = await prepare();
    const work = await commitFile(worktree, "work.txt", "kept on the branch\n");

    await git.removeWorktree(checkout, worktree);
    await git.removeWorktree(checkout, worktree);

    await expect(stat(worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await sh(checkout, "worktree", "list", "--porcelain")).not.toContain(join("worktrees", "item"));
    expect(await git.resolve(checkout, "item")).toBe(work);
  });
});

describe("changes in a worktree", () => {
  it("lists committed, staged, unstaged and untracked paths once each, and both sides of a rename", async () => {
    const { worktree } = await prepare({ "src/app.ts": "app\n", "old-name.txt": "old\n", ".gitignore": "*.log\n" });
    await writeFile(join(worktree, "src/app.ts"), "changed\n");
    await sh(worktree, "mv", "old-name.txt", "new-name.txt");
    await sh(worktree, "commit", "-q", "-a", "-m", "committed work");
    await write(worktree, "staged.txt", "staged\n");
    await sh(worktree, "add", "staged.txt");
    await writeFile(join(worktree, "README.md"), "unstaged edit\n");
    await writeFile(join(worktree, "src/app.ts"), "changed again\n");
    await write(worktree, "fresh/new.ts", "never staged\n");
    await writeFile(join(worktree, "debug.log"), "ignored\n");

    expect(await git.changedPaths(worktree, "origin/main")).toEqual([
      "README.md", "fresh/new.ts", "new-name.txt", "old-name.txt", "src/app.ts", "staged.txt",
    ]);
  });

  it("measures from the merge base, so what landed on the base since is not counted", async () => {
    const { worktree } = await prepare();
    await commitFile(worktree, "mine.txt", "mine\n");
    await landOnOrigin("theirs.txt", "theirs\n");
    await git.sync(repo());

    expect(await git.changedPaths(worktree, "origin/main")).toEqual(["mine.txt"]);
  });

  it("puts paths back as they were at the base and deletes the ones the base never had", async () => {
    const { worktree } = await prepare({ "src/app.ts": "app\n", "tests/app.test.ts": "frozen\n" });
    await writeFile(join(worktree, "tests/app.test.ts"), "weakened\n");
    await sh(worktree, "commit", "-q", "-a", "-m", "weaken the test");
    await rm(join(worktree, "src/app.ts"));
    await write(worktree, "tests/staged.test.ts", "staged\n");
    await sh(worktree, "add", "tests/staged.test.ts");
    await write(worktree, "tests/untracked.test.ts", "never staged\n");
    await write(worktree, "keep.txt", "not asked about\n");

    await git.restorePaths(worktree, "origin/main", [
      "tests/app.test.ts", "src/app.ts", "tests/staged.test.ts", "tests/untracked.test.ts",
    ]);

    expect(await readFile(join(worktree, "tests/app.test.ts"), "utf8")).toBe("frozen\n");
    expect(await readFile(join(worktree, "src/app.ts"), "utf8")).toBe("app\n");
    await expect(stat(join(worktree, "tests/staged.test.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(worktree, "tests/untracked.test.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await git.commit(worktree, "restore");
    expect(await git.changedPaths(worktree, "origin/main")).toEqual(["keep.txt"]);
  });

  it("refuses to restore a path outside the worktree or inside git's own directory", async () => {
    const { worktree } = await prepare();
    const outside = join(root, "outside.txt");
    await writeFile(outside, "not the worktree's\n");
    for (const path of ["../../../outside.txt", outside, ".git", ".git/config", ""]) {
      await expect(git.restorePaths(worktree, "origin/main", [path])).rejects.toThrow(/not a path inside the worktree/);
    }
    expect(await readFile(outside, "utf8")).toBe("not the worktree's\n");
  });

  it("commits everything, untracked files included, and nothing when nothing changed", async () => {
    const { worktree } = await prepare();
    expect(await git.commit(worktree, "nothing yet")).toBeNull();
    await writeFile(join(worktree, "README.md"), "changed\n");
    await write(worktree, "src/new.ts", "new\n");

    const sha = await git.commit(worktree, "work");

    expect(sha).toBe(await git.head(worktree));
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await git.commit(worktree, "again")).toBeNull();
  });

  it("commits only the given paths, whatever else is staged or lying around", async () => {
    const { worktree } = await prepare();
    await write(worktree, "docs/[id].md", "product\n");
    await write(worktree, "docs/i.md", "a glob would take this too\n");
    await write(worktree, "staged-elsewhere.txt", "staged\n");
    await sh(worktree, "add", "staged-elsewhere.txt");

    const sha = await git.commit(worktree, "product files", ["docs/[id].md"]);

    expect(sha).not.toBeNull();
    expect(await sh(worktree, "show", "--name-only", "--format=", sha!)).toBe("docs/[id].md");
    const status = await sh(worktree, "status", "--porcelain");
    expect(status).toContain("A  staged-elsewhere.txt");
    expect(status).toContain("?? docs/i.md");
    expect(await git.commit(worktree, "again", ["docs/[id].md"])).toBeNull();
    expect(await git.commit(worktree, "no paths", [])).toBeNull();
  });
});

describe("reset", () => {
  it("soft keeps the tree and the index, so the next commit squashes several attempts into one", async () => {
    const { worktree } = await prepare();
    const start = await git.head(worktree);
    await commitFile(worktree, "a.txt", "first attempt\n");
    await commitFile(worktree, "b.txt", "second attempt\n");

    await git.reset(worktree, start, "soft");

    expect(await git.head(worktree)).toBe(start);
    expect(await readFile(join(worktree, "a.txt"), "utf8")).toBe("first attempt\n");
    const squashed = await git.commit(worktree, "one attempt");
    expect(squashed).not.toBeNull();
    expect(await sh(worktree, "rev-list", "--count", `${start}..${squashed!}`)).toBe("1");
    expect(await sh(worktree, "show", "--name-only", "--format=", squashed!)).toBe("a.txt\nb.txt");
  });

  it("hard drops committed, uncommitted and untracked work but leaves ignored files in place", async () => {
    const { worktree } = await prepare({ ".gitignore": "node_modules/\n" });
    const start = await git.head(worktree);
    await commitFile(worktree, "attempt.txt", "attempt\n");
    await writeFile(join(worktree, "README.md"), "uncommitted\n");
    await write(worktree, "scratch/new.txt", "untracked\n");
    await write(worktree, "node_modules/dep/index.js", "installed\n");

    await git.reset(worktree, start, "hard");

    expect(await git.head(worktree)).toBe(start);
    expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("seed\n");
    await expect(stat(join(worktree, "attempt.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(worktree, "scratch"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(worktree, "node_modules/dep/index.js"), "utf8")).toBe("installed\n");
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
  });

  it("throws for a ref that names no commit, and touches nothing", async () => {
    const { worktree } = await prepare();
    await writeFile(join(worktree, "README.md"), "uncommitted\n");

    await expect(git.reset(worktree, "no-such-ref", "hard")).rejects.toThrow(/does not name a commit/);
    await expect(git.reset(worktree, "", "soft")).rejects.toThrow(/must be a sha or an existing ref/);
    expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("uncommitted\n");
  });
});

describe("rebase and fast-forward", () => {
  it("rebases onto a moved base", async () => {
    const { worktree } = await prepare();
    await commitFile(worktree, "mine.txt", "mine\n");
    await landOnOrigin("theirs.txt", "theirs\n");
    await git.sync(repo());

    expect(await git.rebase(worktree, "origin/main")).toEqual({ ok: true });

    expect((await runCommand(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: worktree, env })).code)
      .toBe(0);
    expect(await readFile(join(worktree, "mine.txt"), "utf8")).toBe("mine\n");
  });

  it("names the conflicting paths, then leaves the worktree clean on its branch", async () => {
    const { worktree } = await prepare();
    const before = await commitFile(worktree, "README.md", "mine\n");
    await landOnOrigin("README.md", "theirs\n");
    await git.sync(repo());

    const outcome = await git.rebase(worktree, "origin/main");

    expect(outcome).toMatchObject({ ok: false, conflicts: ["README.md"] });
    expect(outcome.ok ? "" : outcome.detail).toContain("CONFLICT");
    expect(await sh(worktree, "status", "--porcelain")).toBe("");
    expect(await sh(worktree, "branch", "--show-current")).toBe("item");
    expect(await git.head(worktree)).toBe(before);
  });

  it("throws when the rebase refuses to start, since there is no conflict to report", async () => {
    const { worktree } = await prepare();
    await landOnOrigin("theirs.txt", "theirs\n");
    await git.sync(repo());
    await writeFile(join(worktree, "README.md"), "uncommitted\n");

    await expect(git.rebase(worktree, "origin/main")).rejects.toThrow(/git rebase origin\/main failed/);
  });

  it("fast-forwards when it can and says false when the branches diverged", async () => {
    const { checkout, worktree } = await prepare();
    await git.ensureBranch(checkout, "integration", "origin/main");
    const integration = join(workRoot, "worktrees", "integration");
    await git.addWorktree(checkout, integration, "integration");
    const work = await commitFile(worktree, "mine.txt", "mine\n");

    expect(await git.fastForward(integration, "item")).toBe(true);
    expect(await git.head(integration)).toBe(work);

    const own = await commitFile(integration, "other.txt", "other\n");
    await commitFile(worktree, "more.txt", "more\n");
    expect(await git.fastForward(integration, "item")).toBe(false);
    expect(await git.head(integration)).toBe(own);

    await expect(git.fastForward(integration, "no-such-branch")).rejects.toThrow(/merge-base/);
  });
});

describe("publishing", () => {
  it("pushes the branch to origin under its own name", async () => {
    const { worktree } = await prepare();
    const work = await commitFile(worktree, "mine.txt", "mine\n");

    await git.push(worktree, "item");

    expect(await sh(originUrl, "rev-parse", "refs/heads/item")).toBe(work);
  });

  it("opens a pull request through gh when none is open, with the body on stdin", async () => {
    const calls: { argv: readonly string[]; options: RunCommandOptions }[] = [];
    const answers = [result({ stdout: "[]\n" }), result({ stdout: "https://github.com/acme/widget/pull/7\n" })];
    const gh: RunCommand = async (argv, options) => {
      calls.push({ argv, options });
      return answers.shift() ?? result({ code: 1 });
    };

    const url = await createGit({ workRoot, run: gh, env: { PATH: "/usr/bin" } }).openPullRequest(
      "/srv/widget",
      { head: "hivemind/coupons", base: "main", title: "Coupons at checkout", body: "Adds coupons." },
    );

    expect(url).toBe("https://github.com/acme/widget/pull/7");
    expect(calls.map((call) => call.argv)).toEqual([
      ["gh", "pr", "list", "--head", "hivemind/coupons", "--base", "main", "--state", "open", "--json", "url"],
      ["gh", "pr", "create", "--head", "hivemind/coupons", "--base", "main", "--title", "Coupons at checkout", "--body-file", "-"],
    ]);
    expect(calls[1]?.options).toMatchObject({ cwd: "/srv/widget", input: "Adds coupons." });
    expect(calls[1]?.options.env).toMatchObject({ GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" });
  });

  it("reuses the pull request already open for the same branches", async () => {
    const calls: (readonly string[])[] = [];
    const gh: RunCommand = async (argv) => {
      calls.push(argv);
      return result({ stdout: "[{\"url\":\"https://github.com/acme/widget/pull/3\"}]\n" });
    };

    const url = await createGit({ workRoot, run: gh, env: {} }).openPullRequest(
      "/srv/widget",
      { head: "hivemind/coupons", base: "main", title: "Coupons at checkout", body: "Adds coupons." },
    );

    expect(url).toBe("https://github.com/acme/widget/pull/3");
    expect(calls).toHaveLength(1);
  });
});
