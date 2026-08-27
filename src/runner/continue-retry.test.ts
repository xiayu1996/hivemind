import { describe, expect, it, vi } from "vitest";
import { promptWithContinueRetry, RetryLimitExceededError } from "./continue-retry.js";
import type { PiRunner, PromptResult } from "./types.js";

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };

const ok = (): PromptResult => ({ settled: true, failure: null, usage: EMPTY_USAGE, events: [] });
const failing = (errorMessage: string): PromptResult => ({
  settled: true,
  failure: { errorMessage, willRetry: false },
  usage: EMPTY_USAGE,
  events: [],
});

function stubRunner(results: PromptResult[], alive = true): PiRunner & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    alive,
    async start() {},
    async prompt(message: string) {
      prompts.push(message);
      return results.shift() ?? ok();
    },
    async steer() {},
    async abort() {},
    async getMessages() { return []; },
    async getState() { return {}; },
    async setAutoRetry() {},
    async stop() {},
    async kill() {},
  } as PiRunner & { prompts: string[] };
}

const noWait = { sleep: async () => {}, backoffMs: () => 0 };

describe("stream interruption", () => {
  it("resumes the same session with continue and reports the retry count", async () => {
    const runner = stubRunner([failing("Connection error."), ok()]);
    const outcome = await promptWithContinueRetry(runner, "do the work", { maxContinueRetries: 8, ...noWait });

    expect(outcome.failure).toBeNull();
    expect(outcome.continueRetries).toBe(1);
    expect(runner.prompts).toEqual(["do the work", "continue"]);
  });

  it("keeps retrying across several interruptions", async () => {
    const runner = stubRunner([failing("terminated"), failing("socket hang up"), ok()]);
    const outcome = await promptWithContinueRetry(runner, "work", { maxContinueRetries: 8, ...noWait });
    expect(outcome.continueRetries).toBe(2);
  });

  it("reports each retry so the event log can record it", async () => {
    const onRetry = vi.fn();
    const runner = stubRunner([failing("Connection error."), ok()]);
    await promptWithContinueRetry(runner, "work", { maxContinueRetries: 8, onRetry, ...noWait });
    expect(onRetry).toHaveBeenCalledWith(1, "Connection error.");
  });

  it("backs off between attempts", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const runner = stubRunner([failing("Connection error."), failing("Connection error."), ok()]);
    await promptWithContinueRetry(runner, "work", {
      maxContinueRetries: 8, sleep, backoffMs: (n) => n * 100,
    });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });
});

describe("ceiling", () => {
  it("stops at the configured limit with a real stop reason", async () => {
    const runner = stubRunner(Array.from({ length: 10 }, () => failing("Connection error.")));
    const promise = promptWithContinueRetry(runner, "work", { maxContinueRetries: 3, ...noWait });

    await expect(promise).rejects.toThrow(RetryLimitExceededError);
    await expect(promise).rejects.toMatchObject({ stopReason: "retry_limit_exceeded", attempts: 3 });
  });

  it("honours a limit of zero by not retrying at all", async () => {
    const runner = stubRunner([failing("Connection error.")]);
    await expect(promptWithContinueRetry(runner, "work", { maxContinueRetries: 0, ...noWait }))
      .rejects.toThrow(RetryLimitExceededError);
    expect(runner.prompts).toEqual(["work"]);
  });
});

describe("failures that retrying cannot fix", () => {
  it("returns a dead credential immediately instead of burning retries", async () => {
    const runner = stubRunner([failing("401: invalid_api_key")]);
    const outcome = await promptWithContinueRetry(runner, "work", { maxContinueRetries: 8, ...noWait });

    expect(outcome.failure!.errorMessage).toMatch(/401/);
    expect(outcome.continueRetries).toBe(0);
    expect(runner.prompts).toEqual(["work"]);
  });

  it("returns a spent quota immediately, which is what stops a harness spinning", async () => {
    const runner = stubRunner([failing("You have hit your ChatGPT usage limit (plus plan). Try again in ~47 min.")]);
    const outcome = await promptWithContinueRetry(runner, "work", { maxContinueRetries: 8, ...noWait });
    expect(outcome.continueRetries).toBe(0);
  });

  it("gives up when the process died, since there is no session left to continue", async () => {
    const runner = stubRunner([failing("Connection error.")], false);
    const outcome = await promptWithContinueRetry(runner, "work", { maxContinueRetries: 8, ...noWait });

    expect(outcome.failure).not.toBeNull();
    expect(outcome.continueRetries).toBe(0);
  });
});

describe("clean runs", () => {
  it("passes through untouched", async () => {
    const runner = stubRunner([ok()]);
    const outcome = await promptWithContinueRetry(runner, "work", { maxContinueRetries: 8, ...noWait });
    expect(outcome).toMatchObject({ failure: null, continueRetries: 0 });
    expect(runner.prompts).toEqual(["work"]);
  });
});
