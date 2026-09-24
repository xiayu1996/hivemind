import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectCheck } from "../pipeline/code-exit-gate.js";
import type { CheckOutcome } from "./subset-verifier.js";

const execFileAsync = promisify(execFile);

/** Enough to hold a runner's failure summary and the first failure's detail. */
const CHECK_OUTPUT_LIMIT = 8000;

/**
 * Runs one declared check in the tree the caller names.
 *
 * Which tree that is carries the whole meaning of the answer, so it is never
 * defaulted here: the merge re-verification runs the same check twice, once on
 * the rebased Story and once on the Epic head without it.
 *
 * A check that never started is reported apart from one that ran and failed: a
 * missing binary says nothing about the code and must not cost the Story a
 * round. The output is kept whole for the failure extractor, which reads the
 * summary at its head, and truncated only for what reaches a prompt.
 */
export async function runProjectCheck(cwd: string, check: ProjectCheck): Promise<CheckOutcome> {
  const [command, ...args] = check.command;
  try {
    const done = await execFileAsync(command!, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { passed: true, detail: done.stdout.trim().slice(-2000) };
  } catch (cause) {
    const output = `${(cause as { stdout?: string }).stdout ?? ""}${(cause as { stderr?: string }).stderr ?? ""}`.trim();
    const code = (cause as { code?: unknown }).code;
    if (output === "" && code !== undefined && typeof code !== "number") {
      // ENOENT, EACCES and friends: the process never ran.
      return { passed: false, spawnError: true, detail: (cause as Error).message };
    }
    return { passed: false, detail: (output === "" ? (cause as Error).message : output).slice(-CHECK_OUTPUT_LIMIT) };
  }
}
