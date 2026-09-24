import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CommandResult, Git, RebaseResult, RepositoryConfig, RunCommand } from "../ports.ts";

export interface GitOptions {
  /** Root the service owns; repository checkouts live under `<workRoot>/repos/<name>`. */
  workRoot: string;
  run: RunCommand;
  /** Environment of every git and gh process (see `baseEnvironment`). */
  env: Record<string, string>;
}

/**
 * Settings that make a missing credential an immediate failure instead of a
 * daemon parked forever on a prompt nobody can see. An empty GIT_ASKPASS also
 * stops git from falling back to SSH_ASKPASS or core.askPass, and the child
 * runs in its own session, so no terminal is left for ssh to ask on either.
 */
const NON_INTERACTIVE = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" } as const;
const GH_NON_INTERACTIVE = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } as const;

/** Local operations should take seconds; the limit only keeps a wedged process from holding the loop. */
const LOCAL_TIMEOUT_MS = 10 * 60_000;
/** A first clone of a large repository over a slow link is the slowest thing here. */
const REMOTE_TIMEOUT_MS = 30 * 60_000;

const DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Cuts credentials embedded in remote URLs out of text before it reaches a
 * log, an error or a page. A token written as userinfo survives every copy of
 * the URL unless it is cut here.
 */
export function redactCredentials(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/]*@/g, "$1***@");
}

/** A password in the URL would be written into the checkout's config, where every worktree can read it. */
function refuseEmbeddedPassword(url: string): void {
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)/.exec(url.trim())?.[1] ?? "";
  const at = authority.lastIndexOf("@");
  if (at >= 0 && authority.slice(0, at).includes(":")) {
    throw new Error("the remote URL carries a password; use a credential helper or an ssh key instead");
  }
}

/**
 * A revision must be a sha or a ref that exists. An empty one once reached git
 * as `checkout --detach ''`, a fatal pathspec error that stopped a whole sweep,
 * and a leading dash would be read as an option; both are refused before git
 * sees them. Existence is left to git, whose refusal is reported in full.
 */
function revision(value: string, label: string): string {
  if (!/^[^\s-]\S*$/.test(value)) throw new Error(`${label} must be a sha or an existing ref, got ${JSON.stringify(value)}`);
  return value;
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path, got ${JSON.stringify(path)}`);
  return resolve(path);
}

/** A repository-relative path that stays inside the worktree and out of git's own directory. */
function insideWorktree(worktree: string, path: string): string {
  const target = resolve(worktree, path);
  const within = relative(worktree, target);
  if (
    path === "" || isAbsolute(path) || within === "" || within === ".."
    || within.startsWith(`..${sep}`) || within.split(sep)[0] === ".git"
  ) {
    throw new Error(`${JSON.stringify(path)} is not a path inside the worktree ${worktree}`);
  }
  return target;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

/**
 * Node builds a failed command's message from stderr alone, and git says some
 * of the most consequential things on stdout: "nothing to commit, working tree
 * clean" is one, the names of conflicting files are another. A failure that
 * carried only stderr once reached the loop as `Command failed: git commit`
 * and nothing else, which nobody could classify. Every failure here carries
 * both streams.
 */
function failure(binary: string, args: readonly string[], cwd: string, result: CommandResult, timeoutMs: number): Error {
  const why = result.spawnError
    ?? (result.timedOut ? `timed out after ${timeoutMs}ms` : `exited with ${result.signal ?? `code ${result.code}`}`);
  const printed = [result.stderr.trim(), result.stdout.trim()].filter((text) => text !== "").join("\n");
  return new Error(redactCredentials(`${binary} ${args.join(" ")} failed in ${cwd}: ${why}${printed === "" ? "" : `\n${printed}`}`));
}

function firstListedUrl(output: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`gh pr list did not print JSON: ${redactCredentials(output.trim().slice(0, 500))}`);
  }
  if (!Array.isArray(parsed)) throw new Error("gh pr list did not print a list");
  const url = (parsed[0] as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && url !== "" ? url : null;
}

/** The repository a remote URL names, whatever credential or trailing spelling it carries. */
const repositoryOf = (url: string): string =>
  url.trim().replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, "$1").replace(/\/+$/, "").replace(/\.git$/, "");

export function createGit(options: GitOptions): Git {
  const workRoot = absolute(options.workRoot, "workRoot");
  const env = { ...options.env, ...NON_INTERACTIVE };
  const ghEnv = { ...env, ...GH_NON_INTERACTIVE };

  /** Runs a command; only a process that never finished is an error here, exit codes are the caller's. */
  const invoke = async (
    args: readonly string[],
    cwd: string,
    call: { binary?: string; timeoutMs?: number; input?: string } = {},
  ): Promise<CommandResult> => {
    const binary = call.binary ?? "git";
    const timeoutMs = call.timeoutMs ?? LOCAL_TIMEOUT_MS;
    const result = await options.run([binary, ...args], {
      cwd,
      env: binary === "gh" ? ghEnv : env,
      timeoutMs,
      ...(call.input === undefined ? {} : { input: call.input }),
    });
    if (result.spawnError !== null || result.timedOut || result.code === null) {
      throw failure(binary, args, cwd, result, timeoutMs);
    }
    return result;
  };

  /** Runs a command that must succeed and returns what it printed. */
  const run = async (
    args: readonly string[],
    cwd: string,
    call: { binary?: string; timeoutMs?: number; input?: string } = {},
  ): Promise<string> => {
    const result = await invoke(args, cwd, call);
    if (result.code !== 0) throw failure(call.binary ?? "git", args, cwd, result, call.timeoutMs ?? LOCAL_TIMEOUT_MS);
    return result.stdout;
  };

  /** Runs a command whose exit code 1 means "no" rather than "failed". */
  const ask = async (args: readonly string[], cwd: string): Promise<CommandResult | null> => {
    const result = await invoke(args, cwd);
    if (result.code === 0) return result;
    if (result.code === 1) return null;
    throw failure("git", args, cwd, result, LOCAL_TIMEOUT_MS);
  };

  const resolveCommit = async (cwd: string, ref: string): Promise<string | null> =>
    (await ask(["rev-parse", "--verify", "--quiet", `${revision(ref, "ref")}^{commit}`], cwd))?.stdout.trim() ?? null;

  const branchExists = async (cwd: string, branch: string): Promise<boolean> =>
    (await ask(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd)) !== null;

  /**
   * The checkout must be of the configured repository. The configured URL may
   * have changed spelling or credential since the clone (a rotated token), so
   * identity is compared without either and the configured URL is written back.
   */
  const checkOrigin = async (path: string, url: string): Promise<void> => {
    const origin = await invoke(["remote", "get-url", "origin"], path);
    const found = origin.code === 0 ? origin.stdout.trim() : "";
    if (repositoryOf(found) !== repositoryOf(url)) {
      throw new Error(redactCredentials(
        `${path} is not the service's checkout of ${url} (its origin is ${found === "" ? "missing" : found}); `
        + "the service clones for itself and will not adopt or overwrite another checkout",
      ));
    }
    if (found !== url) await run(["remote", "set-url", "origin", url], path);
  };

  /**
   * Clones into a private directory next to the target and renames it into
   * place, so a concurrent caller sees either no checkout or a complete one.
   * Returns false when another caller's clone landed first; its tree is as
   * good as this one, so the race is settled by whoever renamed.
   */
  const clone = async (url: string, branch: string, path: string): Promise<boolean> => {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, `.${basename(path)}.clone-`));
    try {
      await run(["clone", "--branch", branch, "--", url, staging], parent, { timeoutMs: REMOTE_TIMEOUT_MS });
      // Detached, because `git worktree add` refuses a branch the main checkout has checked out.
      await run(["switch", "--detach"], staging);
      await rename(staging, path);
      return true;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (await exists(join(path, ".git"))) return false;
      throw error;
    }
  };

  const rebaseInProgress = async (cwd: string): Promise<boolean> => {
    for (const state of ["rebase-merge", "rebase-apply"]) {
      const location = (await run(["rev-parse", "--git-path", state], cwd)).trim();
      if (await exists(resolve(cwd, location))) return true;
    }
    return false;
  };

  return {
    /**
     * The checkout lives in the service's own directory and is always the
     * service's own clone: a person's checkout sits on whatever branch they
     * left it on, with whatever they had not committed yet.
     */
    async sync(repo: RepositoryConfig): Promise<string> {
      if (!DIRECTORY_NAME.test(repo.name)) {
        throw new Error(`repository name ${JSON.stringify(repo.name)} cannot be used as a directory name`);
      }
      const url = repo.url.trim();
      refuseEmbeddedPassword(url);
      const branch = revision(repo.defaultBranch, "defaultBranch");
      const path = join(workRoot, "repos", repo.name);
      if (!(await exists(join(path, ".git")))) {
        const cloned = await clone(url, branch, path);
        if (cloned) return path;
      }
      await checkOrigin(path, url);
      await run(["fetch", "--prune", "origin"], path, { timeoutMs: REMOTE_TIMEOUT_MS });
      // A dirty main checkout means a hand is at work in it; moving it would
      // throw that work away, and nothing here needs the move that badly.
      if ((await run(["status", "--porcelain"], path)).trim() === "") {
        await run(["switch", "--detach", `refs/remotes/origin/${branch}`], path);
      }
      return path;
    },

    async resolve(repoPath, ref) {
      return resolveCommit(absolute(repoPath, "repoPath"), ref);
    },

    async ensureBranch(repoPath, branch, startPoint) {
      const cwd = absolute(repoPath, "repoPath");
      revision(branch, "branch");
      revision(startPoint, "startPoint");
      if (await branchExists(cwd, branch)) return;
      const args = ["branch", "--no-track", branch, startPoint];
      const created = await invoke(args, cwd);
      // Two callers can race here. A branch that appeared in the meantime is
      // the other caller's, cut for the same purpose, so it is kept as it is.
      if (created.code !== 0 && !(await branchExists(cwd, branch))) {
        throw failure("git", args, cwd, created, LOCAL_TIMEOUT_MS);
      }
    },

    /**
     * A worktree directory can disappear without git being told (a disk
     * cleanup, a crash mid-checkout), and git then refuses to put a worktree
     * back at that path, so the branch becomes unreachable and every later
     * round dies on a working directory that does not exist. An interrupted
     * `worktree add` also leaves its registration locked, which `prune` and a
     * single `--force` both leave alone. So the path is pruned and then
     * force-removed twice over; removing names this one path, so no other
     * worktree can be caught by it, and the branch keeps its commits.
     */
    async addWorktree(repoPath, path, branch) {
      const cwd = absolute(repoPath, "repoPath");
      const target = absolute(path, "path");
      revision(branch, "branch");
      await run(["worktree", "prune"], cwd);
      // Failing here is the ordinary case of no registration at all; the add
      // below reports its own reason if something else is in the way.
      await invoke(["worktree", "remove", "--force", "--force", target], cwd);
      await mkdir(dirname(target), { recursive: true });
      await run(["worktree", "add", target, branch], cwd);
    },

    async removeWorktree(repoPath, path) {
      const cwd = absolute(repoPath, "repoPath");
      const target = absolute(path, "path");
      const args = ["worktree", "remove", "--force", "--force", target];
      const removed = await invoke(args, cwd);
      await run(["worktree", "prune"], cwd);
      if (removed.code !== 0 && (await exists(target))) throw failure("git", args, cwd, removed, LOCAL_TIMEOUT_MS);
    },

    async head(worktree) {
      return (await run(["rev-parse", "--verify", "HEAD"], absolute(worktree, "worktree"))).trim();
    },

    /**
     * Repository-relative paths, sorted. Renames are listed as both of their
     * sides, since a file moved away is a file changed, and untracked files
     * count (ignored ones do not), since a file the round created and never
     * staged is still in the tree the next commit takes.
     */
    async changedPaths(worktree, base) {
      const cwd = absolute(worktree, "worktree");
      const since = await ask(["merge-base", revision(base, "base"), "HEAD"], cwd);
      if (since === null) throw new Error(`${base} and the branch checked out at ${cwd} share no history`);
      const mergeBase = since.stdout.trim();
      const listed = [
        await run(["diff", "--name-only", "--no-renames", "-z", mergeBase, "HEAD"], cwd),
        await run(["diff", "--name-only", "--no-renames", "-z", "--cached"], cwd),
        await run(["diff", "--name-only", "--no-renames", "-z"], cwd),
        await run(["ls-files", "--others", "--exclude-standard", "-z"], cwd),
      ];
      return [...new Set(listed.flatMap(splitNul))].toSorted();
    },

    /** `paths` are repository-relative file paths, as `changedPaths` lists them. */
    async restorePaths(worktree, base, paths) {
      const cwd = absolute(worktree, "worktree");
      const baseCommit = await resolveCommit(cwd, revision(base, "base"));
      if (baseCommit === null) throw new Error(`${base} does not name a commit in ${cwd}`);
      // Every path is checked before any is touched, so a bad one cannot leave the rest half done.
      const targets = paths.map((path) => ({ path, target: insideWorktree(cwd, path) }));
      for (const { path, target } of targets) {
        const existedAtBase = (await ask(["rev-parse", "--verify", "--quiet", `${baseCommit}:${path}`], cwd)) !== null;
        if (existedAtBase) {
          await run(["--literal-pathspecs", "checkout", baseCommit, "--", path], cwd);
          continue;
        }
        // Absent at base, so it goes. The index entry and the file are removed
        // separately: a file that was never staged is invisible to `git rm`
        // and `git checkout`, and left on disk it would go straight into the
        // next commit.
        await run(["--literal-pathspecs", "rm", "--cached", "--force", "--quiet", "--ignore-unmatch", "--", path], cwd);
        await rm(target, { recursive: true, force: true });
      }
    },

    async reset(worktree, ref, mode) {
      const cwd = absolute(worktree, "worktree");
      const target = await resolveCommit(cwd, revision(ref, "ref"));
      if (target === null) throw new Error(`${ref} does not name a commit in ${cwd}`);
      await run(["reset", "--quiet", mode === "soft" ? "--soft" : "--hard", target], cwd);
      // Ignored files (installed dependencies, build caches) survive a hard reset on purpose: they are expensive and not part of any attempt.
      if (mode === "hard") await run(["clean", "--force", "-d", "--quiet"], cwd);
    },

    /**
     * Nothing staged is answered with null rather than attempted: `git commit`
     * calls that an error and says why only on stdout. With `paths`, only those
     * paths are committed, whatever else happens to be staged.
     */
    async commit(worktree, message, paths) {
      const cwd = absolute(worktree, "worktree");
      if (message.trim() === "") throw new Error("a commit needs a message");
      if (paths !== undefined && paths.length === 0) return null;
      for (const path of paths ?? []) insideWorktree(cwd, path);
      const scope = paths === undefined ? [] : ["--", ...paths];
      await run(["--literal-pathspecs", "add", "--all", ...scope], cwd);
      // `diff --quiet` exits 0 when the index matches HEAD, 1 when something is staged.
      const nothingStaged = (await ask(["--literal-pathspecs", "diff", "--cached", "--quiet", ...scope], cwd)) !== null;
      if (nothingStaged) return null;
      await run(["--literal-pathspecs", "commit", "--quiet", "--message", message, ...scope], cwd);
      return (await run(["rev-parse", "--verify", "HEAD"], cwd)).trim();
    },

    /**
     * The conflicting paths are read before the rebase is aborted, since the
     * abort erases them, and then the worktree is put back: a rebase left
     * standing sits detached with the conflict in the tree, and every later
     * round in that worktree would start from it. The conflict is something to
     * report, not something to keep. A rebase that refused to start at all
     * (a dirty tree, an unknown upstream) is not a conflict and throws.
     */
    async rebase(worktree, onto): Promise<RebaseResult> {
      const cwd = absolute(worktree, "worktree");
      const args = ["rebase", revision(onto, "onto")];
      const attempt = await invoke(args, cwd);
      if (attempt.code === 0) return { ok: true };
      if (!(await rebaseInProgress(cwd))) throw failure("git", args, cwd, attempt, LOCAL_TIMEOUT_MS);
      const conflicts = splitNul(await run(["diff", "--name-only", "--diff-filter=U", "-z"], cwd)).toSorted();
      const abort = await invoke(["rebase", "--abort"], cwd);
      if (abort.code !== 0) {
        throw new Error(`the worktree ${cwd} is still mid-rebase: ${failure("git", ["rebase", "--abort"], cwd, abort, LOCAL_TIMEOUT_MS).message}`);
      }
      const detail = [attempt.stdout.trim(), attempt.stderr.trim()].filter((text) => text !== "").join("\n");
      return { ok: false, conflicts, detail: redactCredentials(detail) };
    },

    async fastForward(worktree, ref) {
      const cwd = absolute(worktree, "worktree");
      const isAncestor = (await ask(["merge-base", "--is-ancestor", "HEAD", revision(ref, "ref")], cwd)) !== null;
      if (!isAncestor) return false;
      await run(["merge", "--ff-only", ref], cwd);
      return true;
    },

    /** A plain push: the branch only moves forward, so a rejected push means another writer and must be loud. */
    async push(worktree, branch) {
      const cwd = absolute(worktree, "worktree");
      revision(branch, "branch");
      await run(["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], cwd, { timeoutMs: REMOTE_TIMEOUT_MS });
    },

    /**
     * Reuses the open pull request for the same head and base, so a second
     * call after a refusal elsewhere does not trip the platform's "already
     * exists". The body travels on stdin, out of reach of the argv size limit.
     */
    async openPullRequest(repoPath, input) {
      const cwd = absolute(repoPath, "repoPath");
      revision(input.head, "head");
      revision(input.base, "base");
      if (input.title.trim() === "") throw new Error("a pull request needs a title");
      const gh = { binary: "gh", timeoutMs: REMOTE_TIMEOUT_MS };
      const listed = await run(
        ["pr", "list", "--head", input.head, "--base", input.base, "--state", "open", "--json", "url"],
        cwd,
        gh,
      );
      const open = firstListedUrl(listed);
      if (open !== null) return open;
      const created = await run(
        ["pr", "create", "--head", input.head, "--base", input.base, "--title", input.title, "--body-file", "-"],
        cwd,
        { ...gh, input: input.body },
      );
      const url = /https:\/\/\S+/.exec(created)?.[0].replace(/[),.;]+$/, "");
      if (url === undefined) throw new Error(`gh pr create printed no pull request URL: ${redactCredentials(created.trim())}`);
      return url;
    },
  };
}
