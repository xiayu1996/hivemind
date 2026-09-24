import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { CommandResult, RunCommand } from "../ports.ts";

/** Time a process group gets between SIGTERM and SIGKILL. */
export const STOP_GRACE_MS = 2_000;

/** Applied when the caller sets no limit, so a runaway process cannot exhaust memory. */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * What a child process may see of the environment this service was started
 * from.
 *
 * Children run code that a model wrote and that the loop then judges, with no
 * person in between, while the service's own environment carries every
 * credential in `secrets.env`: a deployed host loads that file into the unit.
 * Handing all of it over was never intended and is not needed. What a child
 * legitimately needs is a shell to run in and the address of the data it
 * serves; anything else is declared by the caller and passed as `extra`.
 */
const INHERITED = [
  "PATH", "HOME", "TMPDIR", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ",
  // Where the data it serves lives. The child is expected to work on a copy of
  // it; handing over the address is not handing over permission.
  "HIVEMIND_DB_URL",
] as const;

/** A minimal child environment: the allowlisted variables of this process plus `extra`. */
export function baseEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/**
 * Signals every process in the group led by `pid` (children are spawned
 * detached, so each leads its own group and a dev server's or test runner's
 * own children are reached too). Signal 0 only asks whether any member is
 * left. Returns false when the group is empty.
 */
export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // ESRCH: nothing is left in the group. EPERM would need a member that
    // switched to another user, which nothing here could stop either way.
    return false;
  }
}

/**
 * Says which of two things ENOENT meant. Node reports a missing working
 * directory exactly as it reports a missing binary (`spawn git ENOENT`), and a
 * worktree that had been deleted once stopped a card on that message: it reads
 * as a host without git, an operator finds git installed and has nowhere left
 * to look. The directory is named because it is the repairable part.
 */
export async function describeSpawnError(error: unknown, file: string, cwd: string): Promise<string> {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" && !(await isDirectory(cwd))) {
    return `${file} could not start: its working directory ${cwd} does not exist`;
  }
  return `${file} could not start: ${error instanceof Error ? error.message : String(error)}`;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((entry) => entry.isDirectory(), () => false);
}

/**
 * Keeps the first and the last half of `limit` bytes and drops the middle.
 * The tail alone is the wrong end to keep: test runners print what failed
 * before the stack traces and diffs, so a tail-only cut once handed a merge
 * round 800 bytes of a coloured diff and never the name of the failing test.
 * The head alone would lose the final summary and the exit reason.
 */
function boundedOutput(limit: number): { push(chunk: Buffer): void; text(): string } {
  const headLimit = Math.ceil(limit / 2);
  const tailLimit = limit - headLimit;
  const head: Buffer[] = [];
  const tail: Buffer[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let dropped = 0;
  return {
    push(chunk) {
      let rest = chunk;
      if (headBytes < headLimit) {
        const taken = rest.subarray(0, headLimit - headBytes);
        head.push(taken);
        headBytes += taken.length;
        rest = rest.subarray(taken.length);
      }
      if (rest.length === 0) return;
      tail.push(rest);
      tailBytes += rest.length;
      while (tailBytes > tailLimit) {
        const first = tail[0]!;
        const excess = tailBytes - tailLimit;
        if (first.length <= excess) {
          tail.shift();
          tailBytes -= first.length;
          dropped += first.length;
        } else {
          tail[0] = first.subarray(excess);
          tailBytes -= excess;
          dropped += excess;
        }
      }
    },
    text() {
      if (dropped === 0) return Buffer.concat([...head, ...tail]).toString("utf8");
      // Both cuts can land inside a multi-byte character: the decoder holds back
      // an incomplete sequence at the end of the head, and continuation bytes at
      // the start of the tail are skipped, so neither side shows a broken glyph.
      const start = new StringDecoder("utf8").write(Buffer.concat(head));
      let end = Buffer.concat(tail);
      let skip = 0;
      while (skip < 3 && skip < end.length && (end[skip]! & 0xc0) === 0x80) skip += 1;
      end = end.subarray(skip);
      return `${start}\n[... ${dropped + skip} bytes omitted ...]\n${end.toString("utf8")}`;
    },
  };
}

/**
 * Runs `argv` with exactly `options.env` (nothing is inherited) in its own
 * process group. On timeout the whole group gets SIGTERM, then SIGKILL after
 * STOP_GRACE_MS. Never throws: a missing executable or working directory is
 * reported as `spawnError`.
 *
 * A process the command left behind in its group can hold the output pipes
 * open, and with them this call, long after the command itself exited. Once
 * the command has exited, anything still holding the pipes after
 * STOP_GRACE_MS is killed and the result is reported as it stood.
 */
export const runCommand: RunCommand = async (argv, options) => {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const notStarted = (spawnError: string): CommandResult => ({
    code: null, signal: null, stdout: "", stderr: "", spawnError, timedOut: false, durationMs: elapsed(),
  });
  const [file, ...args] = argv;
  if (file === undefined || file === "") return notStarted("no command was given");

  let child: ChildProcess;
  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    // Invalid arguments (an empty file name, a NUL byte in argv) throw
    // synchronously instead of emitting "error".
    return notStarted(await describeSpawnError(error, file, options.cwd));
  }

  const limit = Math.max(0, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const stdout = boundedOutput(limit);
  const stderr = boundedOutput(limit);
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  // A read error ends the stream and the exit is still reported; without a
  // listener the error event would take the whole service down instead.
  child.stdout?.on("error", () => undefined);
  child.stderr?.on("error", () => undefined);
  if (options.input !== undefined && child.stdin) {
    // EPIPE when the command exits without reading all of its input; its exit
    // status already says what happened.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  }

  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    let spawnFailed = false;
    let timedOut = false;
    let exit: { code: number | null; signal: string | null } | null = null;
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, action: () => void) => {
      timers.push(setTimeout(action, ms));
    };
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(result);
    };
    const finish = () => settle({
      code: exit?.code ?? null,
      signal: exit?.signal ?? null,
      stdout: stdout.text(),
      stderr: stderr.text(),
      spawnError: null,
      timedOut,
      durationMs: elapsed(),
    });
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined) signalGroup(child.pid, signal);
    };

    child.on("error", (error) => {
      // Only a failed spawn leaves the child without a pid; any other error of
      // a running child is followed by its exit, which reports the outcome.
      if (child.pid !== undefined || spawnFailed) return;
      spawnFailed = true;
      void describeSpawnError(error, file, options.cwd).then((description) => settle(notStarted(description)));
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      later(STOP_GRACE_MS, () => {
        kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      });
    });
    child.once("close", () => {
      // After a failed spawn "close" still fires, with a negated errno as its
      // code; the "error" handler reports that case.
      if (!spawnFailed) finish();
    });
    if (options.timeoutMs !== undefined) {
      later(options.timeoutMs, () => {
        timedOut = true;
        kill("SIGTERM");
        later(STOP_GRACE_MS, () => kill("SIGKILL"));
      });
    }
  });
};
