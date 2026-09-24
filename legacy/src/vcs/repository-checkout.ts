import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitInvocation {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Git as this module needs it: never throwing, so a failure can be classified
 * from its own stderr rather than from an exception's shape.
 *
 * `GIT_TERMINAL_PROMPT=0` is what makes a missing credential an immediate
 * failure instead of a daemon parked forever on a password prompt nobody can
 * see.
 */
export interface RemoteGitPort {
  run(args: readonly string[], cwd?: string): Promise<GitInvocation>;
}

export const processRemoteGit: RemoteGitPort = {
  async run(args, cwd) {
    try {
      const result = await execFileAsync("git", [...args], {
        ...(cwd ? { cwd } : {}),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" },
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number; message: string };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        code: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  },
};

export type CheckoutFailureKind = "auth" | "not_found" | "network" | "unknown";

export class CheckoutError extends Error {
  constructor(readonly kind: CheckoutFailureKind, message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Removes anything a remote URL may carry that must not reach a log or a page.
 * A token embedded as userinfo is the common case, and it survives every copy
 * of the URL unless it is cut here.
 */
export function redactRemoteUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, "//***@").replace(/^([^@\s/]+):[^@\s/]*@/, "$1:***@");
}

function pathSegmentsOf(url: string): { segments: string[]; remote: boolean } {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(trimmed);
  if (scheme) {
    const rest = scheme[2]!;
    const slash = rest.indexOf("/");
    if (slash < 0) throw new CheckoutError("unknown", `remote URL names no repository: ${redactRemoteUrl(url)}`);
    const authority = rest.slice(0, slash);
    if (/[^@]*:[^@]*@/.test(authority)) {
      throw new CheckoutError("unknown", "remote URL carries a password; use a credential helper or an ssh key instead");
    }
    const segments = rest.slice(slash + 1).split("/").filter(Boolean);
    return { segments, remote: scheme[1]!.toLowerCase() !== "file" };
  }
  const scp = /^([^@\s:/]+@)?([^\s:/]+):(.+)$/.exec(trimmed);
  if (scp && !isAbsolute(trimmed)) {
    if (scp[1] && /:/.test(scp[1])) {
      throw new CheckoutError("unknown", "remote URL carries a password; use a credential helper or an ssh key instead");
    }
    return { segments: scp[3]!.split("/").filter(Boolean), remote: true };
  }
  return { segments: trimmed.split("/").filter(Boolean), remote: false };
}

/**
 * The owner/name slug a repository is keyed by everywhere else: cards, config
 * scopes, review requests and the Notion board all already say owner/name.
 *
 * A remote whose path is deeper than owner/name (a nested group) is refused
 * rather than flattened: the slug is a primary key, and two different nested
 * paths can flatten onto the same one.
 */
export function repositorySlugFromUrl(url: string): string {
  const { segments, remote } = pathSegmentsOf(url);
  if (remote && segments.length !== 2) {
    throw new CheckoutError(
      "unknown",
      `cannot derive an owner/name slug from ${redactRemoteUrl(url)}: hivemind keys repositories by owner/name`,
    );
  }
  const tail = segments.slice(-2);
  if (tail.length !== 2 || !tail.every((segment) => SEGMENT.test(segment))) {
    throw new CheckoutError("unknown", `cannot derive an owner/name slug from ${redactRemoteUrl(url)}`);
  }
  return tail.join("/");
}

/** The single path segment a slug's checkout lives under on every machine. */
export function checkoutKey(slug: string): string {
  const name = slug.slice(slug.indexOf("/") + 1);
  if (!SEGMENT.test(name)) throw new Error(`repository slug has no usable name: ${slug}`);
  return name;
}

/**
 * Where this machine keeps a repository. The path is derived, never stored: it
 * is machine state, and a row that recorded one would be wrong on every other
 * node the moment a second one exists.
 */
export function checkoutPath(workRoot: string, slug: string): string {
  return resolve(workRoot, "repos", checkoutKey(slug));
}

function classify(stderr: string): CheckoutFailureKind {
  const text = stderr.toLowerCase();
  if (/authentication failed|permission denied|could not read username|invalid username or password|access denied|403/.test(text)) {
    return "auth";
  }
  if (/repository not found|does not appear to be a git repository|not found|404/.test(text)) return "not_found";
  if (/could not resolve host|connection (timed out|refused|reset)|network is unreachable|temporary failure in name resolution|operation timed out/.test(text)) {
    return "network";
  }
  return "unknown";
}

function fail(action: string, url: string, result: GitInvocation): never {
  const kind = classify(result.stderr);
  throw new CheckoutError(kind, `${action} ${redactRemoteUrl(url)} failed (${kind}): ${redactRemoteUrl(result.stderr.trim()) || `git exited ${result.code}`}`);
}

/**
 * The branch the remote itself calls default. Asking the remote is also the
 * cheapest proof that the credentials on this machine can reach it, which is
 * why registration and the readiness probe both go through here.
 */
export async function remoteDefaultBranch(url: string, git: RemoteGitPort = processRemoteGit): Promise<string> {
  const result = await git.run(["ls-remote", "--symref", url, "HEAD"]);
  if (result.code !== 0) fail("reading the default branch of", url, result);
  const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(result.stdout);
  if (!match) throw new CheckoutError("unknown", `${redactRemoteUrl(url)} did not name a default branch`);
  return match[1]!;
}

export interface CheckoutRequest {
  url: string;
  slug: string;
  defaultBranch: string;
  workRoot: string;
}

export interface CheckoutState {
  path: string;
  /** What this call had to do: nothing, a first clone, or a fetch. */
  action: "present" | "cloned" | "refreshed";
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function assertOrigin(path: string, request: CheckoutRequest, git: RemoteGitPort): Promise<void> {
  const origin = await git.run(["remote", "get-url", "origin"], path);
  if (origin.code !== 0) {
    throw new CheckoutError("unknown", `${path} is not a git checkout of ${request.slug}`);
  }
  const found = repositorySlugFromUrl(origin.stdout.trim());
  if (found !== request.slug) {
    throw new CheckoutError("unknown", `${path} is a checkout of ${found}, not of ${request.slug}`);
  }
}

/**
 * Brings this machine's checkout of a repository into existence, from nothing
 * but the clone URL.
 *
 * The checkout stays detached at origin's default branch: every Story and Epic
 * works in a worktree cut from it, and `git worktree add` refuses a branch
 * that the main checkout has checked out. A clone lands through a rename from
 * a private directory, so a second resident racing the same repository sees
 * either no checkout or a complete one, never half of one.
 */
export async function ensureCheckout(
  request: CheckoutRequest,
  options: { refresh?: boolean; git?: RemoteGitPort } = {},
): Promise<CheckoutState> {
  const git = options.git ?? processRemoteGit;
  const path = checkoutPath(request.workRoot, request.slug);
  if (await exists(resolve(path, ".git"))) {
    await assertOrigin(path, request, git);
    if (!options.refresh) return { path, action: "present" };
    const fetched = await git.run(["fetch", "--prune", "origin"], path);
    if (fetched.code !== 0) fail("fetching", request.url, fetched);
    const dirty = await git.run(["status", "--porcelain"], path);
    // A dirty main checkout is somebody's hand at work; moving it would throw
    // their edits away, and nothing here needs that badly enough.
    if (dirty.code === 0 && dirty.stdout.trim() === "") {
      await git.run(["switch", "--detach", `origin/${request.defaultBranch}`], path);
    }
    return { path, action: "refreshed" };
  }
  const staging = `${path}.tmp-${process.pid}`;
  await mkdir(resolve(path, ".."), { recursive: true });
  await rm(staging, { recursive: true, force: true });
  const cloned = await git.run(["clone", "--branch", request.defaultBranch, request.url, staging]);
  if (cloned.code !== 0) {
    await rm(staging, { recursive: true, force: true });
    fail("cloning", request.url, cloned);
  }
  await git.run(["switch", "--detach"], staging);
  try {
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // Another resident finished its clone first. Its tree is as good as this
    // one, so the race is settled by whoever renamed, not by re-cloning.
    if (!(await exists(resolve(path, ".git")))) throw error;
    await assertOrigin(path, request, git);
    return { path, action: "present" };
  }
  return { path, action: "cloned" };
}
