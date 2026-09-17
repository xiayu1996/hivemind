import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CheckoutError,
  checkoutKey,
  checkoutPath,
  ensureCheckout,
  processRemoteGit,
  redactRemoteUrl,
  remoteDefaultBranch,
  repositorySlugFromUrl,
  type GitInvocation,
  type RemoteGitPort,
} from "./repository-checkout.js";

interface Call { args: string[]; cwd?: string | undefined }

/**
 * Git as a recording double. Clone is the one command with a filesystem
 * effect the caller depends on, so the double performs it; everything else is
 * answered from a table.
 */
function fakeGit(answers: Partial<Record<string, GitInvocation>> = {}): RemoteGitPort & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(args, cwd) {
      calls.push({ args: [...args], cwd });
      const answer = answers[args[0]!];
      if (args[0] === "clone" && !answer) {
        await mkdir(join(args.at(-1)!, ".git"), { recursive: true });
      }
      return answer ?? { stdout: "", stderr: "", code: 0 };
    },
  };
}

describe("repositorySlugFromUrl", () => {
  it("reads owner/name out of every remote form an operator pastes", () => {
    const cases: [string, string][] = [
      ["https://github.com/xiayu1996/hivemind.git", "xiayu1996/hivemind"],
      ["https://github.com/xiayu1996/hivemind", "xiayu1996/hivemind"],
      ["https://token@github.com/xiayu1996/hivemind.git", "xiayu1996/hivemind"],
      ["git@github.com:xiayu1996/hivemind.git", "xiayu1996/hivemind"],
      ["ssh://git@github.com:2222/xiayu1996/hivemind.git", "xiayu1996/hivemind"],
      ["file:///srv/git/acme/widget.git", "acme/widget"],
      ["/srv/git/acme/widget.git", "acme/widget"],
      ["../fixtures/acme/widget", "acme/widget"],
    ];
    for (const [url, slug] of cases) expect(repositorySlugFromUrl(url)).toBe(slug);
  });

  it("refuses a remote whose key would be a guess", () => {
    // A nested group flattens two different repositories onto one slug.
    expect(() => repositorySlugFromUrl("https://gitlab.com/group/sub/widget.git")).toThrow(/owner\/name/);
    expect(() => repositorySlugFromUrl("https://github.com/hivemind.git")).toThrow(/owner\/name/);
    expect(() => repositorySlugFromUrl("https://user:secret@github.com/acme/widget.git")).toThrow(/password/);
  });
});

describe("redactRemoteUrl", () => {
  it("cuts the credential out of a URL before anyone reads it", () => {
    expect(redactRemoteUrl(`https://${"x".repeat(20)}@github.com/acme/widget.git`))
      .toBe("https://***@github.com/acme/widget.git");
    expect(redactRemoteUrl("https://user:secret@github.com/acme/widget.git"))
      .toBe("https://***@github.com/acme/widget.git");
    expect(redactRemoteUrl("git@github.com:acme/widget.git")).toBe("git@github.com:acme/widget.git");
  });
});

describe("checkoutPath", () => {
  it("derives one path per machine from the slug alone", () => {
    expect(checkoutKey("acme/widget")).toBe("widget");
    expect(checkoutPath("/srv/work", "acme/widget")).toBe(resolve("/srv/work/repos/widget"));
  });
});

describe("remoteDefaultBranch", () => {
  it("asks the remote what it calls default", async () => {
    const git = fakeGit({ "ls-remote": { stdout: "ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n", stderr: "", code: 0 } });
    await expect(remoteDefaultBranch("https://github.com/acme/widget.git", git)).resolves.toBe("trunk");
  });

  it("classifies what the remote refused, without repeating the credential", async () => {
    const table: [string, string][] = [
      ["remote: Invalid username or password", "auth"],
      ["remote: Repository not found.", "not_found"],
      ["fatal: Could not resolve host: github.com", "network"],
      ["fatal: something nobody has seen", "unknown"],
    ];
    for (const [stderr, kind] of table) {
      const git = fakeGit({ "ls-remote": { stdout: "", stderr, code: 128 } });
      await expect(remoteDefaultBranch("https://token@github.com/acme/widget.git", git))
        .rejects.toMatchObject({ kind, message: expect.stringContaining("***@github.com") });
    }
  });
});

describe("ensureCheckout", () => {
  let workRoot: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "hivemind-checkout-"));
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  const request = (url = "https://github.com/acme/widget.git") => ({
    url, slug: "acme/widget", defaultBranch: "main", workRoot,
  });

  it("clones a repository this machine has never seen, and leaves it detached", async () => {
    const git = fakeGit();
    await expect(ensureCheckout(request(), { git })).resolves.toEqual({
      path: checkoutPath(workRoot, "acme/widget"), action: "cloned",
    });
    const clone = git.calls.find((call) => call.args[0] === "clone")!;
    expect(clone.args.slice(0, 3)).toEqual(["clone", "--branch", "main"]);
    // Landed through a rename, so a reader never sees a half-cloned tree.
    expect(clone.args.at(-1)).not.toBe(checkoutPath(workRoot, "acme/widget"));
    expect(git.calls.some((call) => call.args[0] === "switch" && call.args[1] === "--detach")).toBe(true);
    await expect(stat(join(checkoutPath(workRoot, "acme/widget"), ".git"))).resolves.toBeDefined();
  });

  it("does nothing to a checkout that is already there", async () => {
    const path = checkoutPath(workRoot, "acme/widget");
    await mkdir(join(path, ".git"), { recursive: true });
    const git = fakeGit({ remote: { stdout: "https://github.com/acme/widget.git\n", stderr: "", code: 0 } });
    await expect(ensureCheckout(request(), { git })).resolves.toMatchObject({ action: "present" });
    expect(git.calls.map((call) => call.args[0])).toEqual(["remote"]);
  });

  it("refuses a directory that is a checkout of something else", async () => {
    const path = checkoutPath(workRoot, "acme/widget");
    await mkdir(join(path, ".git"), { recursive: true });
    const git = fakeGit({ remote: { stdout: "https://github.com/other/widget.git\n", stderr: "", code: 0 } });
    await expect(ensureCheckout(request(), { git })).rejects.toBeInstanceOf(CheckoutError);
  });

  it("leaves a dirty checkout where the person left it, but still fetches", async () => {
    const path = checkoutPath(workRoot, "acme/widget");
    await mkdir(join(path, ".git"), { recursive: true });
    const git = fakeGit({
      remote: { stdout: "https://github.com/acme/widget.git\n", stderr: "", code: 0 },
      status: { stdout: " M src/a.ts\n", stderr: "", code: 0 },
    });
    await expect(ensureCheckout(request(), { git, refresh: true })).resolves.toMatchObject({ action: "refreshed" });
    expect(git.calls.map((call) => call.args[0])).toEqual(["remote", "fetch", "status"]);
  });

  it("accepts the checkout another resident finished first", async () => {
    const path = checkoutPath(workRoot, "acme/widget");
    const git: RemoteGitPort = {
      async run(args) {
        if (args[0] === "clone") {
          await mkdir(join(args.at(-1)!, ".git"), { recursive: true });
          // The other resident lands its clone while this one is still working.
          await mkdir(join(path, ".git"), { recursive: true });
          await writeFile(join(path, "README"), "theirs");
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args[0] === "remote") return { stdout: "https://github.com/acme/widget.git\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    await expect(ensureCheckout(request(), { git })).resolves.toMatchObject({ action: "present" });
  });

  it("reports what a clone was refused for, and leaves nothing behind", async () => {
    const git = fakeGit({ clone: { stdout: "", stderr: "remote: Repository not found.", code: 128 } });
    await expect(ensureCheckout(request(), { git })).rejects.toMatchObject({ kind: "not_found" });
    await expect(stat(checkoutPath(workRoot, "acme/widget"))).rejects.toThrow();
  });

  it("clones a real repository and can cut a worktree on its default branch", async () => {
    const origin = join(workRoot, "origin", "acme", "widget.git");
    const seed = join(workRoot, "seed");
    await mkdir(origin, { recursive: true });
    await mkdir(seed, { recursive: true });
    await processRemoteGit.run(["init", "--bare", "-b", "main", origin]);
    await processRemoteGit.run(["init", "-b", "main", seed]);
    await processRemoteGit.run(["config", "user.email", "test@example.com"], seed);
    await processRemoteGit.run(["config", "user.name", "test"], seed);
    await writeFile(join(seed, "README"), "seed\n");
    await processRemoteGit.run(["add", "."], seed);
    await processRemoteGit.run(["commit", "-m", "seed"], seed);
    await processRemoteGit.run(["push", origin, "main"], seed);

    expect(repositorySlugFromUrl(origin)).toBe("acme/widget");
    await expect(remoteDefaultBranch(origin)).resolves.toBe("main");
    const state = await ensureCheckout({ url: origin, slug: "acme/widget", defaultBranch: "main", workRoot });
    expect(state.action).toBe("cloned");
    const head = await processRemoteGit.run(["symbolic-ref", "--quiet", "HEAD"], state.path);
    // Detached, which is what lets a worktree take the default branch.
    expect(head.code).not.toBe(0);
    const added = await processRemoteGit.run(["worktree", "add", join(workRoot, "wt"), "main"], state.path);
    expect(added.code).toBe(0);
    await expect(ensureCheckout({ url: origin, slug: "acme/widget", defaultBranch: "main", workRoot }))
      .resolves.toMatchObject({ action: "present" });
  });
});
