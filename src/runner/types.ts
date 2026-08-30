import type { ResolvedModel } from "./model-resolver.js";

/** Envelope of everything pi emits on stdout in RPC mode. */
export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface RunnerSpawnOptions {
  provider: string;
  /** Only `resolveModel` can produce this, so no unchecked id reaches a spawn:
   * pi treats an unknown id as a custom model and invents pricing for it. */
  model: ResolvedModel;
  cwd: string;
  sessionDir?: string;
  sessionFile?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Tool allowlist. An empty array disables every tool. */
  tools?: string[];
  extensions?: string[];
  systemPrompt?: { mode: "append" | "replace"; text: string };
  /**
   * pi discovers CLAUDE.md/AGENTS.md upwards from cwd and will pick up unrelated
   * personal instructions. "explicit" turns discovery off; anything the run needs
   * must then be passed deliberately.
   */
  contextFiles?: "explicit" | "inherit";
  env?: Record<string, string>;
}

/**
 * A provider failure as pi reports it: the assistant message carries
 * stopReason "error" and a human-readable errorMessage. The same message is
 * repeated on message_start/message_end/turn_end/agent_end, so one rule covers
 * all of them.
 */
export interface RunFailure {
  errorMessage: string;
  willRetry: boolean | null;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `output`, never added on top of it. */
  reasoning: number;
  costUsd: number;
}

export interface PromptResult {
  settled: boolean;
  failure: RunFailure | null;
  usage: TokenUsage;
  events: RpcEvent[];
}

/**
 * The seam between hivemind and pi. Everything above this interface is written
 * against the port, so the RPC transport can be replaced without touching the
 * pipeline.
 */
export interface PiRunner {
  start(): Promise<void>;
  prompt(message: string, timeoutMs?: number): Promise<PromptResult>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  getMessages(): Promise<unknown[]>;
  getState(): Promise<Record<string, unknown>>;
  setAutoRetry(enabled: boolean): Promise<void>;
  stop(): Promise<void>;
  /** Forceful termination, for watchdogs and quarantine. No graceful shutdown. */
  kill(): Promise<void>;
  readonly alive: boolean;
}

export class RunnerHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerHandshakeError";
  }
}

export class RunnerDeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerDeadError";
  }
}

export class RunnerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerTimeoutError";
  }
}
