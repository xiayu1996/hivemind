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

function untrackedPaths(status: Buffer): string[] {
  return status
    .toString("utf8")
    .split("\0")
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
  const status = gitBuffer(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const unstaged = gitBuffer(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const staged = gitBuffer(root, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const hash = createHash("sha256");
  updateField(hash, "head", head);
  updateField(hash, "status", status);
  updateField(hash, "unstaged", unstaged);
  updateField(hash, "staged", staged);

  for (const relativePath of untrackedPaths(status)) {
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
