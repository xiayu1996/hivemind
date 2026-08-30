import { execFile } from "node:child_process";
import { mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { isWithinRoot } from "../guard/danger-rules.js";

const execFileAsync = promisify(execFile);

export interface WorktreeLayout {
  root: string;
  worktrees: string;
  quarantine: string;
  evidence: string;
}

export interface WorktreeLocation {
  worktreePath: string;
  quarantineRoot: string;
  evidencePath: string;
}

export interface CreateWorktreeInput {
  repositoryPath: string;
  repositoryId: string;
  cardId: string;
  branch: string;
  startPoint: string;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is not a safe path segment`);
  }
  return value;
}

export function worktreeLayout(root = resolve(homedir(), "hivemind-work")): WorktreeLayout {
  const absolute = resolve(root);
  return {
    root: absolute,
    worktrees: resolve(absolute, "worktrees"),
    quarantine: resolve(absolute, "quarantine"),
    evidence: resolve(absolute, "evidence"),
  };
}

export function locateWorktree(
  repositoryId: string,
  cardId: string,
  layout = worktreeLayout(),
): WorktreeLocation {
  const repo = safeSegment(repositoryId, "repositoryId");
  const card = safeSegment(cardId, "cardId");
  return {
    worktreePath: resolve(layout.worktrees, repo, card),
    quarantineRoot: resolve(layout.quarantine, repo),
    evidencePath: resolve(layout.evidence, repo, card),
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Creates a branch worktree without relying on a process-local ownership lock.
 * Reuses an existing story branch when a previous worktree was removed without
 * merging, so a re-dispatch never stalls on its own stale branch. */
export async function createWorktree(
  input: CreateWorktreeInput,
  layout = worktreeLayout(),
): Promise<WorktreeLocation> {
  const location = locateWorktree(input.repositoryId, input.cardId, layout);
  if (await exists(location.worktreePath)) throw new Error(`worktree already exists: ${location.worktreePath}`);
  await mkdir(resolve(location.worktreePath, ".."), { recursive: true });
  await mkdir(location.evidencePath, { recursive: true });
  const branchExists = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`],
    { cwd: resolve(input.repositoryPath), windowsHide: true },
  ).then(() => true, () => false);
  const args = branchExists
    ? ["worktree", "add", location.worktreePath, input.branch]
    : ["worktree", "add", "-b", input.branch, location.worktreePath, input.startPoint];
  await execFileAsync("git", args, { cwd: resolve(input.repositoryPath), windowsHide: true });
  return location;
}

/** Moves a suspect worktree aside. Quarantine is recoverable and never deletes data. */
export async function quarantineWorktree(
  worktreePath: string,
  reason: string,
  layout = worktreeLayout(),
  now = Date.now,
): Promise<string> {
  const source = resolve(worktreePath);
  if (!isWithinRoot(source, layout.worktrees) || source === layout.worktrees) {
    throw new Error("quarantine source is outside the managed worktree root");
  }
  if (!(await exists(source))) throw new Error(`worktree does not exist: ${source}`);
  const suffix = `${now()}-${safeSegment(reason.replaceAll(/[^A-Za-z0-9._-]/g, "-"), "reason")}`;
  const destination = resolve(layout.quarantine, basename(resolve(source, "..")), `${basename(source)}-${suffix}`);
  if (!isWithinRoot(destination, layout.quarantine) || destination === layout.quarantine) {
    throw new Error("quarantine destination is outside the managed quarantine root");
  }
  await mkdir(resolve(destination, ".."), { recursive: true });
  await rename(source, destination);
  return destination;
}
