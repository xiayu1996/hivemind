import { describe, expect, it, vi } from "vitest";
import type { GuardPolicy } from "../guard/policy.js";
import type { PiRunner, PromptResult, RpcEvent } from "../runner/types.js";
import { BlindVerifyExecutor, type TreePinPort, type VerifyRecord } from "./executor.js";

function assistant(content: string): RpcEvent {
  return { type: "message_end", message: { role: "assistant", content } };
}

function runner(options: { session?: string; content?: string; events?: RpcEvent[] } = {}): PiRunner & { prompts: string[] } {
  const prompts: string[] = [];
  const events = options.events ?? [
    { type: "test_result", scenarioId: "S-EPIC-01-unit", status: "passed" },
    assistant(options.content ?? JSON.stringify({ scenarios: [{ id: "S-EPIC-01-unit", status: "passed" }] })),
  ];
  return {
    prompts,
    alive: true,
    start: vi.fn(async () => undefined),
    setAutoRetry: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ sessionFile: options.session ?? "verify.jsonl" })),
    prompt: vi.fn(async (message: string): Promise<PromptResult> => {
      prompts.push(message);
      return {
        settled: true,
        failure: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
        events,
      };
    }),
    stop: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    kill: vi.fn(async () => undefined),
  };
}

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

function pins(changed = false): TreePinPort {
  let count = 0;
  return {
    capture: () => ({ head: "abc", digest: changed && count++ > 0 ? "after" : "before" }),
    quarantine: vi.fn(async () => undefined),
  };
}

describe("BlindVerifyExecutor", () => {
  it("uses a fresh session, a VERIFY read-only policy, and no CODE transcript", async () => {
    const created: GuardPolicy[] = [];
    const instance = runner();
    const stored: VerifyRecord[] = [];
    const executor = new BlindVerifyExecutor(
      { create: (policy) => { created.push(policy); return instance; } },
      { insert: async (record) => { stored.push(record); } },
      pins(),
      (() => { let time = 100; return () => time++; })(),
    );

    const result = await executor.run(input());

    expect(result.record.verdict).toBe("accepted");
    expect(result.record.verifySessionId).not.toBe(input().codeSessionId);
    expect(created[0]).toMatchObject({ phase: "VERIFY", extraWriteRoots: [input().evidencePath] });
    expect(created[0]?.disallowedTools).toContain("write");
    expect(created[0]?.bannedBash.join(" ")).toContain("commit");
    expect(instance.prompts[0]).not.toContain(input().codeSessionId);
    expect(instance.prompts[0]).not.toContain("private coding rationale");
    expect(stored).toHaveLength(1);
  });

  it("refuses a runner that reuses the CODE session", async () => {
    const instance = runner({ session: "code.jsonl" });
    const records: VerifyRecord[] = [];
    const result = await new BlindVerifyExecutor(
      { create: () => instance },
      { insert: async (record) => { records.push(record); } },
      pins(),
    ).run(input());

    expect(result.record.verdict).toBe("inconclusive");
    expect(result.validationErrors).toContain("VERIFY runner reused the CODE session");
    expect(instance.prompts).toEqual([]);
  });

  it("quarantines a changed tree and rejects an otherwise passing verdict", async () => {
    const pin = pins(true);
    const result = await new BlindVerifyExecutor(
      { create: () => runner() },
      { insert: async () => undefined },
      pin,
    ).run(input());

    expect(result.treeChanged).toBe(true);
    expect(result.record.verdict).toBe("rejected");
    expect(pin.quarantine).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed model output", async () => {
    const result = await new BlindVerifyExecutor(
      { create: () => runner({ content: "not json" }) },
      { insert: async () => undefined },
      pins(),
    ).run(input());

    expect(result.record.verdict).toBe("inconclusive");
    expect(result.validationErrors.join(" ")).toMatch(/JSON|Unexpected token/i);
  });

  it("extracts evidence from real pi toolResult messages without the echo protocol", async () => {
    const events = [
      {
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "\u2713 src/util/format.test.ts > S-EPIC-01-unit rounds correctly\nTests 1 passed (1)" }],
        },
      },
      assistant(JSON.stringify({ scenarios: [{ id: "S-EPIC-01-unit", status: "passed" }] })),
    ];
    const result = await new BlindVerifyExecutor(
      { create: () => runner({ events }) },
      { insert: async () => undefined },
      pins(),
    ).run(input());
    expect(result.record.verdict).toBe("accepted");
  });

  it("extracts observed scenario results from real pi tool execution events", async () => {
    const events = [
      {
        type: "tool_execution_end",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "HIVEMIND_TEST_RESULT S-EPIC-01-unit passed\n" }] },
      },
      assistant(JSON.stringify({ scenarios: [{ id: "S-EPIC-01-unit", status: "passed" }] })),
    ];
    const result = await new BlindVerifyExecutor(
      { create: () => runner({ events }) },
      { insert: async () => undefined },
      pins(),
    ).run(input());
    expect(result.record.verdict).toBe("accepted");
  });
});
