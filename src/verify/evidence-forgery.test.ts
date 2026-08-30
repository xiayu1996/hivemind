import { describe, expect, it, vi } from "vitest";
import type { PiRunner, PromptResult, RpcEvent } from "../runner/types.js";
import { BlindVerifyExecutor, type TreePinPort } from "./executor.js";

function toolResult(text: string, isError = false): RpcEvent {
  return { type: "message_end", message: { role: "toolResult", isError, content: [{ type: "text", text }] } };
}

function runner(events: RpcEvent[]): PiRunner {
  return {
    alive: true,
    start: vi.fn(async () => undefined),
    setAutoRetry: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ sessionFile: "verify.jsonl" })),
    prompt: vi.fn(async (): Promise<PromptResult> => ({
      settled: true,
      failure: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
      events,
    })),
    stop: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    kill: vi.fn(async () => undefined),
  };
}

function pins(): TreePinPort {
  return { capture: () => ({ head: "abc", digest: "before" }), quarantine: vi.fn(async () => undefined) };
}

const claimsPassed: RpcEvent = {
  type: "message_end",
  message: { role: "assistant", content: JSON.stringify({ scenarios: [{ id: "S-EPIC-01-unit", status: "passed" }] }) },
};

function input() {
  return {
    cardId: "story-1",
    round: 1,
    codeSessionId: "code.jsonl",
    worktreePath: "C:/work/story-1",
    evidencePath: "C:/evidence/story-1",
    auditPath: "C:/evidence/story-1/audit.jsonl",
    specification: "The feature returns the expected result.",
    declaredScenarioIds: ["S-EPIC-01-unit"],
    allowedHosts: ["localhost"],
    commitMessages: ["test(S-EPIC-01-unit): red", "feat(S-EPIC-01-unit): green"],
  };
}

async function verdictOf(events: RpcEvent[]) {
  return new BlindVerifyExecutor(
    { create: () => runner(events) },
    { insert: async () => undefined },
    pins(),
  ).run(input());
}

describe("verify evidence cannot be forged from arbitrary tool output", () => {
  it("rejects a self-reported pass whose only trace is source text that mentions the scenario", async () => {
    const grepOutput = [
      'src/verify/executor.ts:118:  evidence.push({ type: "test_result", scenarioId, status: "passed" });',
      "src/util/format.test.ts:4:  // @scenario S-EPIC-01-unit passed through the rounding path",
    ].join("\n");
    const result = await verdictOf([toolResult(grepOutput), claimsPassed]);

    expect(result.record.verdict).toBe("rejected");
    expect(result.validationErrors.join(" ")).toMatch(/no passing test result/);
  });

  it("reads a failing runner line as failed even when the test title contains the word passed", async () => {
    const failing = " \u00d7 src/util/format.test.ts > S-EPIC-01-unit returns passed for a green run 3ms";
    const result = await verdictOf([toolResult(failing), claimsPassed]);

    expect(result.record.verdict).toBe("rejected");
    expect(result.record.failedScenarios).toContain("S-EPIC-01-unit");
  });

  it("ignores output from a tool call that itself failed", async () => {
    const output = " \u2713 src/util/format.test.ts > S-EPIC-01-unit rounds correctly 1ms";
    const result = await verdictOf([toolResult(output, true), claimsPassed]);

    expect(result.record.verdict).toBe("rejected");
    expect(result.validationErrors.join(" ")).toMatch(/no passing test result/);
  });
});
