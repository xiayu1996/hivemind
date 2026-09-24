import { classifyError } from "./classify.js";
import { RunnerTimeoutError, type PiRunner, type PromptImage, type PromptResult, type RpcEvent, type TokenUsage } from "./types.js";

export class RetryLimitExceededError extends Error {
  readonly stopReason = "retry_limit_exceeded" as const;
  constructor(readonly attempts: number, readonly lastError: string) {
    super(`continue-retry exhausted after ${attempts} attempts: ${lastError}`);
    this.name = "RetryLimitExceededError";
  }
}

export interface ContinueRetryOptions {
  maxContinueRetries: number;
  /** Called before each retry, for the event log. */
  onRetry?: (attempt: number, errorMessage: string) => void;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
}

export interface RunOutcome extends PromptResult {
  /** How many "continue" messages were needed. */
  continueRetries: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultBackoff = (attempt: number) => Math.min(30_000, 1_000 * 2 ** (attempt - 1));

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 } as const;

/**
 * A prompt that never settles is an interruption, not a verdict on the work.
 * The process and its in-memory session are still there, so the turn is
 * abandoned and resumed like any other broken stream; replaying the whole phase
 * would throw away everything the session had already done, which for a long
 * CODE phase is most of the round.
 */
async function promptOnce(
  runner: PiRunner,
  message: string,
  timeoutMs?: number,
  images?: readonly PromptImage[],
): Promise<PromptResult> {
  try {
    return await runner.prompt(message, timeoutMs, images);
  } catch (cause) {
    if (!(cause instanceof RunnerTimeoutError) || !runner.alive) throw cause;
    // pi keeps the steering and follow-up queue across an abort and continues it
    // afterwards, so a turn abandoned here would otherwise resume under
    // instructions written for the stream that just broke.
    await runner.clearQueue().catch(() => undefined);
    await runner.abort().catch(() => undefined);
    return {
      settled: false,
      failure: { errorMessage: cause.message, willRetry: null },
      usage: { ...NO_USAGE },
      events: [],
    };
  }
}

/**
 * Sends a prompt and rides out stream interruptions.
 *
 * Under RPC the pi process stays alive and the session stays in memory, so a
 * broken stream does not cost the conversation: sending "continue" to the same
 * session resumes it far more cheaply than replaying the phase.
 *
 * Only failures classified as retryable get this treatment. A dead credential or
 * a spent quota is returned to the caller immediately — retrying those burns the
 * budget without changing the outcome, which is how a harness ends up spinning.
 */
export async function promptWithContinueRetry(
  runner: PiRunner,
  message: string,
  options: ContinueRetryOptions,
  timeoutMs?: number,
  /** Sent with the first prompt only; a resumed session already holds them. */
  images?: readonly PromptImage[],
): Promise<RunOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const backoff = options.backoffMs ?? defaultBackoff;

  let result = await promptOnce(runner, message, timeoutMs, images);
  // Every attempt reports only the events it produced itself, so keeping the
  // last result alone throws away everything the interrupted attempt had
  // already done: the tests it ran, the pages it opened, the tokens it spent.
  // A VERIFY round resumed after a broken stream was judged on the tail alone
  // and reported that its scenarios had left no evidence at all; the cost
  // ceiling, which reads the same usage, was undercounting by the same amount.
  const events: RpcEvent[] = [...result.events];
  let usage: TokenUsage = result.usage;
  let attempts = 0;

  while (result.failure) {
    const classification = classifyError(result.failure.errorMessage);
    if (!classification.retryable) break;

    if (attempts >= options.maxContinueRetries) {
      throw new RetryLimitExceededError(attempts, result.failure.errorMessage);
    }
    if (!runner.alive) {
      // The session is gone, so "continue" has nothing to continue. Recovery is
      // the caller's job: resume from a checkpoint or re-enter the phase.
      break;
    }

    attempts++;
    options.onRetry?.(attempts, result.failure.errorMessage);
    await sleep(backoff(attempts));
    const next = await promptOnce(runner, "continue", timeoutMs);
    // Pushed one at a time: a tool-heavy turn emits tens of thousands of
    // events, past the argument count a spread would pass at once.
    for (const event of next.events) events.push(event);
    usage = addUsage(usage, next.usage);
    result = next;
  }

  return { ...result, events, usage, continueRetries: attempts };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: left.reasoning + right.reasoning,
    costUsd: left.costUsd + right.costUsd,
  };
}
