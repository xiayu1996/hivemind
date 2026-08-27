import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonlDecoder, encodeCommand } from "./jsonl.js";
import { extractFailure, sumUsage } from "./failure.js";
import {
  RunnerDeadError,
  RunnerHandshakeError,
  RunnerTimeoutError,
  type PiRunner,
  type PromptResult,
  type RpcEvent,
  type RpcResponse,
  type RunnerSpawnOptions,
} from "./types.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 900_000;
const SIGKILL_GRACE_MS = 5_000;

export interface RpcRunnerConfig extends RunnerSpawnOptions {
  binary: string;
  /** How long the startup round trip may take before the process is killed. */
  handshakeTimeoutMs?: number;
}

/**
 * Drives one `pi --mode rpc` subprocess.
 *
 * A runner owns exactly one process for its lifetime. If the handshake fails the
 * process is killed rather than reused: cumora's zombie app-server came from
 * carrying on with a subprocess whose startup had already gone wrong, and the
 * failure then surfaced much later as unexplained hangs.
 */
export class RpcPiRunner implements PiRunner {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #decoder = new JsonlDecoder();
  #events: RpcEvent[] = [];
  #responses = new Map<string, RpcResponse>();
  #listeners = new Set<() => void>();
  #stderr = "";
  #exit: { code: number | null; signal: string | null } | null = null;
  #nextId = 1;

  constructor(private readonly config: RpcRunnerConfig) {}

  get alive(): boolean {
    return this.#proc !== null && this.#exit === null;
  }

  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#proc) throw new Error("runner already started");

    this.#proc = spawn(this.config.binary, ["--mode", "rpc", ...buildArgs(this.config)], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stdout.on("data", (chunk: string) => this.#ingest(chunk));
    this.#proc.stderr.setEncoding("utf8");
    this.#proc.stderr.on("data", (chunk: string) => { this.#stderr += chunk; });
    this.#proc.on("exit", (code, signal) => {
      this.#exit = { code, signal };
      this.#notify();
    });
    this.#proc.on("error", (err) => {
      this.#stderr += `\nspawn error: ${err.message}`;
      this.#exit = { code: null, signal: null };
      this.#notify();
    });

    // The handshake is a real round trip, not just "the process is up": a pi that
    // started but cannot answer is exactly the state that must not be reused.
    try {
      await this.#request({ type: "get_state" }, this.config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
    } catch (cause) {
      await this.#killNow();
      throw new RunnerHandshakeError(
        `pi did not complete the RPC handshake: ${(cause as Error).message}. stderr: ${this.#stderr.slice(0, 500)}`,
      );
    }
  }

  async prompt(message: string, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS): Promise<PromptResult> {
    const from = this.#events.length;
    const settledBefore = this.#count("agent_settled");

    const response = await this.#request({ type: "prompt", message }, COMMAND_TIMEOUT_MS);
    if (!response.success) {
      // Command-level rejection: the run never started, so there is no event to read.
      throw new Error(`prompt rejected: ${response.error ?? "unknown reason"}`);
    }

    await this.#waitFor(
      () => this.#count("agent_settled") > settledBefore,
      "agent_settled",
      timeoutMs,
    );

    const events = this.#events.slice(from);
    return {
      settled: true,
      failure: extractFailure(events),
      usage: sumUsage(events),
      events,
    };
  }

  async steer(message: string): Promise<void> {
    const response = await this.#request({ type: "steer", message }, COMMAND_TIMEOUT_MS);
    if (!response.success) throw new Error(`steer rejected: ${response.error ?? "unknown reason"}`);
  }

  async abort(): Promise<void> {
    await this.#request({ type: "abort" }, COMMAND_TIMEOUT_MS);
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    const response = await this.#request({ type: "set_auto_retry", enabled }, COMMAND_TIMEOUT_MS);
    if (!response.success) throw new Error(`set_auto_retry rejected: ${response.error ?? "unknown reason"}`);
  }

  async getMessages(): Promise<unknown[]> {
    const response = await this.#request({ type: "get_messages" }, COMMAND_TIMEOUT_MS);
    const messages = response.data?.messages;
    return Array.isArray(messages) ? messages : [];
  }

  async getState(): Promise<Record<string, unknown>> {
    const response = await this.#request({ type: "get_state" }, COMMAND_TIMEOUT_MS);
    return response.data ?? {};
  }

  /** Every event seen so far, for checkpointing and audit. */
  events(): readonly RpcEvent[] {
    return this.#events;
  }

  /**
   * Terminates the process immediately. Used by watchdogs, by quarantine, and to
   * reproduce a host dying mid-run.
   */
  async kill(): Promise<void> {
    await this.#killNow();
  }

  async stop(): Promise<void> {
    if (!this.#proc || this.#exit) return;
    this.#proc.stdin.end();
    const exited = await this.#waitFor(() => this.#exit !== null, "exit", SIGKILL_GRACE_MS, true)
      .then(() => true)
      .catch(() => false);
    if (!exited) await this.#killNow();
  }

  #ingest(chunk: string): void {
    for (const line of this.#decoder.push(chunk)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Keep unparseable output rather than dropping it: silently discarding a
        // record would hide a protocol drift behind a missing event.
        this.#events.push({ type: "__unparseable__", raw: line });
        continue;
      }
      const record = parsed as RpcEvent | RpcResponse;
      if (record.type === "response") {
        const response = record as RpcResponse;
        if (response.id) this.#responses.set(response.id, response);
      } else {
        this.#events.push(record as RpcEvent);
      }
    }
    this.#notify();
  }

  #count(type: string): number {
    let n = 0;
    for (const event of this.#events) if (event.type === type) n++;
    return n;
  }

  async #request(command: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
    if (!this.#proc || this.#exit) throw new RunnerDeadError("pi process is not running");
    const id = `c${this.#nextId++}`;
    this.#proc.stdin.write(encodeCommand({ ...command, id }));
    await this.#waitFor(() => this.#responses.has(id), `response to ${String(command.type)}`, timeoutMs);
    return this.#responses.get(id)!;
  }

  #waitFor(predicate: () => boolean, label: string, timeoutMs: number, allowExit = false): Promise<void> {
    if (predicate()) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const finish = (err?: Error) => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        if (err) reject(err); else resolve();
      };
      const check = () => {
        if (predicate()) finish();
        else if (this.#exit && !allowExit) {
          finish(new RunnerDeadError(`pi exited while waiting for ${label}: ${this.#stderr.slice(0, 300)}`));
        }
      };
      const timer = setTimeout(() => finish(new RunnerTimeoutError(`timed out waiting for ${label}`)), timeoutMs);
      this.#listeners.add(check);
      check();
    });
  }

  #notify(): void {
    // Iterate a snapshot: a listener that resolves removes itself, and one that
    // starts a new wait would otherwise be visited within this same pass.
    // oxlint-disable-next-line no-useless-spread
    for (const listener of [...this.#listeners]) listener();
  }

  async #killNow(): Promise<void> {
    const proc = this.#proc;
    if (!proc || this.#exit) return;
    proc.kill("SIGKILL");
    await this.#waitFor(() => this.#exit !== null, "kill", SIGKILL_GRACE_MS, true).catch(() => undefined);
  }
}

function buildArgs(config: RpcRunnerConfig): string[] {
  const args = ["--provider", config.provider, "--model", config.model];

  if (config.thinking) args.push("--thinking", config.thinking);
  if (config.sessionDir) args.push("--session-dir", config.sessionDir);
  if (config.sessionFile) args.push("--session", config.sessionFile);
  for (const ext of config.extensions ?? []) args.push("-e", ext);

  if (config.tools) {
    if (config.tools.length === 0) args.push("-nt");
    else args.push("-t", config.tools.join(","));
  }

  if (config.systemPrompt) {
    args.push(config.systemPrompt.mode === "append" ? "--append-system-prompt" : "--system-prompt",
      config.systemPrompt.text);
  }

  // Default to explicit: pi otherwise walks up from cwd and can load personal
  // CLAUDE.md/AGENTS.md files that have nothing to do with the run.
  if ((config.contextFiles ?? "explicit") === "explicit") args.push("--no-context-files");

  return args;
}
