import type { Git } from "../ports.ts";
import { matchesGlob } from "./path-glob.ts";

/**
 * Gate three: after a session, every path it was not allowed to change is put
 * back. The tool guard refuses such writes at the door, but a session with a
 * shell can write anywhere, so the rule is held by looking at what actually
 * changed rather than at what was attempted. Putting a path back is not a
 * failure of the attempt: the gates that follow judge the tree as it should
 * have been left.
 */

/** The product files: written by the planner, read by everyone else. */
export const PRODUCT_FILES = ".hivemind/**";

/** Where the planner runs throwaway spikes; never committed. */
export const SCRATCH = ".hivemind/scratch/**";

export type Writer = "planner" | "builder" | "evaluator";

export function mayChange(writer: Writer, path: string): boolean {
  switch (writer) {
    case "planner":
      return matchesGlob(path, PRODUCT_FILES);
    case "builder":
      return !matchesGlob(path, PRODUCT_FILES);
    case "evaluator":
      return false;
  }
}

/** Restores every path changed since `base` that `writer` may not change, and returns them. */
export async function enforceFence(git: Git, worktree: string, base: string, writer: Writer): Promise<readonly string[]> {
  const changed = await git.changedPaths(worktree, base);
  const forbidden = changed.filter((path) => !mayChange(writer, path));
  if (forbidden.length > 0) await git.restorePaths(worktree, base, forbidden);
  return forbidden;
}
