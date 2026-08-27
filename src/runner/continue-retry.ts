import { classifyError } from "./classify.js";
import type { PiRunner, PromptResult } from "./types.js";

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
): Promise<RunOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const backoff = options.backoffMs ?? defaultBackoff;

  let result = await runner.prompt(message, timeoutMs);
  let attempts = 0;

  while (result.failure) {
    const classification = classifyError(result.failure.errorMessage);
    if (!classification.retryable) return { ...result, continueRetries: attempts };

    if (attempts >= options.maxContinueRetries) {
      throw new RetryLimitExceededError(attempts, result.failure.errorMessage);
    }
    if (!runner.alive) {
      // The session is gone, so "continue" has nothing to continue. Recovery is
      // the caller's job: resume from a checkpoint or re-enter the phase.
      return { ...result, continueRetries: attempts };
    }

    attempts++;
    options.onRetry?.(attempts, result.failure.errorMessage);
    await sleep(backoff(attempts));
    result = await runner.prompt("continue", timeoutMs);
  }

  return { ...result, continueRetries: attempts };
}
