import type { PendingUiPrompt } from "./activity.js";
import type { ResolvedModel, ThinkingLevel } from "./model-resolver.js";

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
  thinking?: ThinkingLevel;
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
  /**
   * pi also discovers skills and prompt templates from the host, and appends
   * them to the system prompt. A captured payload carried nine of the host
   * owner's personal skills, 5,199 bytes of them, none related to the task.
   * The cost is the smaller half: the list differs per machine, so it breaks
   * the invariant that the same inputs rebuild the same prompt byte for byte.
   * "explicit" turns discovery off; `skills` below is then the whole surface.
   */
  skillDiscovery?: "explicit" | "inherit";
  /** Skill files or directories loaded deliberately, in a stable order. */
  skills?: string[];
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

/**
 * Steering and follow-up messages pi had queued but not yet delivered.
 *
 * `abort` deliberately keeps the queue and continues it, so abandoning a turn
 * without clearing first hands the next turn instructions written for the one
 * that was just thrown away.
 */
export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

/**
 * An image sent with a prompt, in pi's `ImageContent` shape. Only a model whose
 * catalogue row advertises image input may be sent one: pi relays the content
 * to the provider either way, and a text-only model answers with a provider
 * error that says nothing about what was actually wrong.
 */
export interface PromptImage {
  data: string;
  mimeType: string;
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
  prompt(message: string, timeoutMs?: number, images?: readonly PromptImage[]): Promise<PromptResult>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  /** Removes queued steering and follow-up messages and returns their text. */
  clearQueue(): Promise<QueuedMessages>;
  getMessages(): Promise<unknown[]>;
  getState(): Promise<Record<string, unknown>>;
  setAutoRetry(enabled: boolean): Promise<void>;
  stop(): Promise<void>;
  /** Forceful termination, for watchdogs and quarantine. No graceful shutdown. */
  kill(): Promise<void>;
  readonly alive: boolean;
  /**
   * Extension dialogs pi is blocked on. Non-empty means the run is waiting for a
   * person, which a heartbeat must not count as work in progress.
   */
  readonly waitingOnUser: readonly PendingUiPrompt[];
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
