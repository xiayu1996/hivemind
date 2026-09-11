import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The application the UI acceptance reviewer looks at.
 *
 * The functional lane hands the reviewer screenshots; it does not hand it a
 * running page with data on it, which is why a review of a screen that needs
 * fixture data used to come back inconclusive. The repository says how its
 * application starts and how sample data gets into it; this module runs both
 * and reports what happened. Nothing here throws past the caller: a page that
 * cannot be brought up is the box's fault and is reported as such, never as
 * the Story's failure and never as a rejected promise that would park a card.
 */
export interface AppStartInput {
  cwd: string;
  /** argv; an empty array means there is nothing to start. */
  command: readonly string[];
  /** Polled until it answers 2xx/3xx; empty means do not wait. */
  readyUrl: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string | undefined>>;
  log?: (line: string) => void;
}

export type AppStartResult =
  | { started: true; url: string }
  | { started: false; reason: string };

export interface AppSeedInput {
  cwd: string;
  command: readonly string[];
  scenarioId: string;
  seed: string;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

export interface AppSeedResult {
  ok: boolean;
  output: string;
}

const OUTPUT_LIMIT = 8 * 1024;
const READY_POLL_MS = 500;
const STOP_GRACE_MS = 2_000;
const DEFAULT_SEED_TIMEOUT_MS = 60_000;

function tail(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(text.length - OUTPUT_LIMIT) : text;
}

async function ready(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(READY_POLL_MS * 4) });
    return response.status >= 200 && response.status < 400;
  } catch {
    // Connection refused, reset or timed out: the application is not listening
    // yet. Anything else fetch can raise is a bad URL, which the poll loop
    // reports as a timeout with the URL named, so the caller sees it either way.
    return false;
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Negative pid addresses the process group the child leads (it was spawned
    // detached), so a dev server's own children die with it.
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone; there is nothing left to stop.
  }
}

export class AppUnderReview {
  private child: ChildProcess | null = null;
  private exited: Promise<string> | null = null;
  private output = "";

  async start(input: AppStartInput): Promise<AppStartResult> {
    if (input.command.length === 0) return { started: false, reason: "no application start command is configured" };
    if (this.child) return { started: false, reason: "an application is already running" };
    const [file, ...args] = input.command;
    const log = input.log ?? (() => undefined);
    let child: ChildProcess;
    try {
      child = spawn(file!, args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return { started: false, reason: `could not spawn ${file}: ${(error as Error).message}` };
    }
    this.child = child;
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      this.output = tail(this.output + text);
      for (const line of text.split("\n")) if (line.trim()) log(line);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    this.exited = new Promise<string>((resolve) => {
      child.once("error", (error) => resolve(`could not spawn ${file}: ${error.message}`));
      child.once("exit", (code, signal) => resolve(`exited with ${signal ?? `code ${code}`}`));
    });
    child.unref();

    if (!input.readyUrl) return { started: true, url: "" };
    const deadline = Date.now() + input.timeoutMs;
    let exitReason: string | null = null;
    void this.exited.then((reason) => { exitReason = reason; });
    while (Date.now() < deadline) {
      if (exitReason !== null) {
        await this.stop();
        return { started: false, reason: `the application ${exitReason} before answering at ${input.readyUrl}: ${this.output.trim()}` };
      }
      if (await ready(input.readyUrl)) return { started: true, url: input.readyUrl };
      await sleep(READY_POLL_MS);
    }
    await this.stop();
    return {
      started: false,
      reason: `the application did not answer at ${input.readyUrl} within ${input.timeoutMs}ms: ${this.output.trim()}`,
    };
  }

  /** Kills the application's process group; safe to call when nothing runs. */
  async stop(): Promise<void> {
    const child = this.child;
    const exited = this.exited;
    this.child = null;
    this.exited = null;
    if (!child || !exited) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    killGroup(child, "SIGTERM");
    const outcome = await Promise.race([exited, sleep(STOP_GRACE_MS).then(() => "grace elapsed")]);
    if (outcome === "grace elapsed") {
      killGroup(child, "SIGKILL");
      await exited;
    }
  }

  /** Runs the seed command once for one scenario; the seed text travels in the environment. */
  async seed(input: AppSeedInput): Promise<AppSeedResult> {
    if (input.command.length === 0) return { ok: false, output: "no seed command is configured" };
    const [file, ...args] = input.command;
    return new Promise<AppSeedResult>((resolve) => {
      let output = "";
      let child: ChildProcess;
      try {
        child = spawn(file!, args, {
          cwd: input.cwd,
          env: {
            ...process.env,
            ...input.env,
            HIVEMIND_SEED: input.seed,
            HIVEMIND_SCENARIO: input.scenarioId,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({ ok: false, output: `could not spawn ${file}: ${(error as Error).message}` });
        return;
      }
      const collect = (chunk: Buffer) => { output = tail(output + chunk.toString()); };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        output += `\nseed command killed after ${input.timeoutMs ?? DEFAULT_SEED_TIMEOUT_MS}ms`;
      }, input.timeoutMs ?? DEFAULT_SEED_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, output: `could not spawn ${file}: ${error.message}` });
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, output: code === 0 ? output.trim() : `${output.trim()}\nexited with ${signal ?? `code ${code}`}`.trim() });
      });
    });
  }
}
