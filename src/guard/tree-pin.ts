import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { isWithinRoot } from "./danger-rules.js";

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export interface TreePin {
  head: string;
  digest: string;
}

export interface TreePinEvaluation {
  matches: boolean;
  verdictValid: boolean;
  quarantineRequired: boolean;
}

function gitBuffer(worktreePath: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: worktreePath,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitHead(worktreePath: string): string {
  try {
    return gitBuffer(worktreePath, ["rev-parse", "HEAD"]).toString("utf8").trim();
  } catch {
    // A newly initialised repository can legitimately be pinned before its
    // first commit; all content still enters through status and untracked data.
    return "UNBORN";
  }
}

function updateField(hash: ReturnType<typeof createHash>, label: string, value: Buffer | string): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(`${label}:${bytes.length}:`, "utf8");
  hash.update(bytes);
}

/**
 * View-state files the operating system writes into a directory it opens.
 *
 * Matched by exact basename and only while untracked: a repository that tracks
 * one has made it content, and changing it is then the agent's doing. Nothing
 * builds from these, so excluding them hides nowhere to cheat -- and including
 * them cost a real round. macOS rewrites `.DS_Store` whenever a directory's
 * view changes, which during VERIFY is whenever the browser lane opens one, so
 * a repository that does not ignore the file had its verdict discarded and its
 * whole checkout quarantined for a file no agent touched (S-R237511OV-02,
 * 2026-09-19). The repository's own ignore rule fixes one repository; this
 * fixes every repository hivemind is given.
 */
const OS_ARTIFACTS = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function isOsArtifact(relativePath: string): boolean {
  return OS_ARTIFACTS.has(relativePath.split("/").pop() ?? "");
}

/**
 * Splits porcelain v1 -z records, dropping untracked OS artifacts.
 *
 * A rename or copy record is followed by its source path as a separate entry,
 * so both travel together; only `?? ` records are ever dropped, and those
 * never carry a second entry.
 */
function statusEntries(status: Buffer): string[] {
  const raw = status.toString("utf8").split("\0").filter((entry) => entry !== "");
  const kept: string[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index]!;
    if (entry.startsWith("?? ") && isOsArtifact(entry.slice(3))) continue;
    kept.push(entry);
    if (/^[RC]/.test(entry) && index + 1 < raw.length) kept.push(raw[++index]!);
  }
  return kept;
}

function untrackedPaths(entries: readonly string[]): string[] {
  return entries
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .toSorted((a, b) => a.localeCompare(b, "en"));
}

/**
 * Fingerprints every git-visible worktree change without mutating the index.
 * Ignored build output stays outside the pin so VERIFY may compile and test;
 * tracked and untracked source bytes are included so a same-path rewrite is
 * still detected.
 */
export function captureTreePin(worktreePath: string): TreePin {
  const root = resolve(worktreePath);
  const head = gitHead(root);
  const entries = statusEntries(
    gitBuffer(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  const unstaged = gitBuffer(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const staged = gitBuffer(root, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const hash = createHash("sha256");
  updateField(hash, "head", head);
  updateField(hash, "status", entries.join("\0"));
  updateField(hash, "unstaged", unstaged);
  updateField(hash, "staged", staged);

  for (const relativePath of untrackedPaths(entries)) {
    const absolutePath = resolve(root, relativePath);
    if (!isWithinRoot(absolutePath, root)) {
      throw new Error(`git reported an untracked path outside the worktree: ${relativePath}`);
    }
    const stat = lstatSync(absolutePath);
    updateField(hash, "untracked-path", relativePath);
    updateField(
      hash,
      "untracked-content",
      stat.isSymbolicLink() ? readlinkSync(absolutePath) : readFileSync(absolutePath),
    );
  }

  return { head, digest: hash.digest("hex") };
}

/** Mismatch is fail-closed: the verifier's result cannot survive a changed tree. */
export function evaluateTreePin(before: TreePin, after: TreePin): TreePinEvaluation {
  const matches = before.head === after.head && before.digest === after.digest;
  return {
    matches,
    verdictValid: matches,
    quarantineRequired: !matches,
  };
}

/**
 * Says which half of the pin moved, for the quarantine that follows.
 *
 * The reason used to be one fixed sentence, so what a quarantine left behind
 * was a whole checkout and no statement of what was different about it -- and
 * a tree sitting in quarantine collects artifacts of its own, which read like
 * the cause and are not. A commit during VERIFY and a file written during
 * VERIFY are different accusations and want different first questions.
 */
export function describeTreePinMismatch(before: TreePin, after: TreePin): string {
  if (before.head !== after.head) {
    return `HEAD moved ${before.head.slice(0, 8)} -> ${after.head.slice(0, 8)}`;
  }
  if (before.digest !== after.digest) return `tree content changed at ${before.head.slice(0, 8)}`;
  return "nothing changed";
}
