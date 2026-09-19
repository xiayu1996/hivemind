import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { testAgentSpec } from "../runner/agent-spec.testing.js";
import type { GuardPolicy } from "../guard/policy.js";
import type { PiRunner, PromptResult, RpcEvent } from "../runner/types.js";
import { BlindVerifyExecutor, type TreePinPort, type VerifyRecord } from "./executor.js";

// The executor writes the browser config under the worktree, so the paths must be real and disposable.
const scratch = mkdtempSync(join(tmpdir(), "hivemind-verify-"));
// Left behind, one per run: 886 of them had collected in the host's temp directory.
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    waitingOnUser: [],
    getMessages: vi.fn(async () => []),
    kill: vi.fn(async () => undefined),
  };
}

/** The verifier's spawn spec, the same for every case here. */
const VERIFY_SPEC = await testAgentSpec({ purpose: "verify" });

function input() {
  return {
    spec: VERIFY_SPEC,
    cardId: "story-1",
    round: 1,
    codeSessionId: "code.jsonl",
    worktreePath: join(scratch, "work", "story-1"),
    evidencePath: join(scratch, "evidence", "story-1"),
    auditPath: join(scratch, "evidence", "story-1", "audit.jsonl"),
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

/**
 * A round wide enough to contain a file the run itself wrote. The window is
 * real evidence handling -- a snapshot from before the round is refused -- so a
 * test about something else must not depend on how the two clocks interleave.
 */
function roundAround(): () => number {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return Date.now() - 60_000;
    }
    return Date.now() + 60_000;
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

  it("tells the verifier about the browser only when there is a host it may open", async () => {
    const withHosts = runner();
    await new BlindVerifyExecutor({ create: () => withHosts }, { insert: async () => undefined }, pins()).run(input());
    expect(withHosts.prompts[0]).toContain("playwright-cli");
    expect(withHosts.prompts[0]).toContain("-s=story-1-verify-1");
    expect(withHosts.prompts[0]).toContain("these hosts: localhost;");
    expect(withHosts.prompts[0]).toContain("$HIVEMIND_EVIDENCE_DIR/service.log");

    const withoutHosts = runner();
    await new BlindVerifyExecutor({ create: () => withoutHosts }, { insert: async () => undefined }, pins())
      .run({ ...input(), allowedHosts: [] });
    expect(withoutHosts.prompts[0]).not.toContain("playwright-cli");
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

  it("calls a round the box lost inconclusive instead of spending an inner-loop round on it", async () => {
    // The 2026-09-05 run spent four rounds on a dev server that was not up.
    const instance = runner({
      events: [assistant(JSON.stringify({
        scenarios: [{ id: "S-EPIC-01-unit", status: "failed", reason: "connection refused on http://localhost:5173" }],
      }))],
    });
    const executor = new BlindVerifyExecutor(
      { create: () => instance },
      { insert: async () => undefined },
      pins(),
    );

    const result = await executor.run(input());
    expect(result.record.verdict).toBe("inconclusive");
    expect(result.record.failedScenarios).toEqual(["S-EPIC-01-unit"]);
  });

  it("keeps the verifier's reason for every scenario that did not pass", async () => {
    const events = [
      { type: "test_result", scenarioId: "S-EPIC-01-unit", status: "failed" },
      assistant(JSON.stringify({ scenarios: [
        { id: "S-EPIC-01-unit", status: "failed", reason: "vitest reported 1 failed: expected 2 to be 3" },
      ] })),
    ];
    const result = await new BlindVerifyExecutor(
      { create: () => runner({ events }) },
      { insert: async () => undefined },
      pins(),
    ).run(input());
    expect(result.record.verdict).toBe("rejected");
    expect(result.reasons).toEqual([
      { scenarioId: "S-EPIC-01-unit", reason: "vitest reported 1 failed: expected 2 to be 3" },
    ]);
  });

  it("counts a scenario whose evidence claim was refused as failed, so the loop sees it", async () => {
    const events = [
      { type: "test_result", scenarioId: "S-EPIC-01-unit", status: "passed" },
      assistant(JSON.stringify({ scenarios: [
        { id: "S-EPIC-01-unit", status: "passed", url: "http://127.0.0.1:<port>/x", screenshots: ["missing.png"] },
      ] })),
    ];
    const result = await new BlindVerifyExecutor(
      { create: () => runner({ events }) },
      { insert: async () => undefined },
      pins(),
    ).run(input());
    expect(result.record.verdict).toBe("rejected");
    expect(result.record.failedScenarios).toEqual(["S-EPIC-01-unit"]);
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      "S-EPIC-01-unit: URL is invalid",
      "S-EPIC-01-unit: screenshot does not exist (missing.png)",
    ]));
  });

  it("fails a scenario the verifier called passed when the page never showed what it declared", async () => {
    // The shape of the real round that started all of this: four confident
    // verdicts against a page whose whole body was a 404.
    await mkdir(input().evidencePath, { recursive: true });
    await writeFile(
      join(input().evidencePath, "page-1.yml"),
      '- generic [ref=e1]: "{\\"message\\":\\"Route GET:/x not found\\"}"',
    );
    const events = [
      { type: "test_result", scenarioId: "S-EPIC-01-unit", status: "passed" },
      assistant(JSON.stringify({ scenarios: [
        { id: "S-EPIC-01-unit", status: "passed", snapshots: ["page-1.yml"] },
      ] })),
    ];
    const result = await new BlindVerifyExecutor(
      { create: () => runner({ events }) },
      { insert: async () => undefined },
      pins(),
    ).run({
      ...input(),
      visibleRequirements: new Map([["S-EPIC-01-unit", [{ role: "heading", text: "运行控制台" }]]]),
    });

    expect(result.record.verdict).toBe("rejected");
    expect(result.record.failedScenarios).toEqual(["S-EPIC-01-unit"]);
    expect(result.reasons).toContainEqual({
      scenarioId: "S-EPIC-01-unit",
      reason: "页面上没有出现这个场景声明要看见的内容：heading “运行控制台”",
    });
  });

  // The verifier is the only session standing in front of the page, so a
  // missing page structure record is asked for there. Sent to CODE instead it
  // is a finding nobody can act on, and the round repeats until the card parks.
  it("asks the verifier for the page structure record it judged by, in its own session", async () => {
    await mkdir(input().evidencePath, { recursive: true });
    const claimed = { type: "test_result", scenarioId: "S-EPIC-01-unit", status: "passed" };
    const replies = [
      [claimed, assistant(JSON.stringify({ scenarios: [{ id: "S-EPIC-01-unit", status: "passed" }] }))],
      [assistant(JSON.stringify({ scenarios: [
        { id: "S-EPIC-01-unit", status: "passed", snapshots: ["page-late.yml"] },
      ] }))],
    ];
    const asked: string[] = [];
    const late = {
      ...runner(),
      prompt: vi.fn(async (message: string): Promise<PromptResult> => {
        asked.push(message);
        writeFileSync(join(input().evidencePath, "page-late.yml"), '- heading "运行控制台" [level=1] [ref=e1]');
        return {
          settled: true,
          failure: null,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
          events: replies[Math.min(asked.length - 1, replies.length - 1)]!,
        };
      }),
    };
    const result = await new BlindVerifyExecutor(
      { create: () => late },
      { insert: async () => undefined },
      pins(),
      roundAround(),
    ).run({
      ...input(),
      visibleRequirements: new Map([["S-EPIC-01-unit", [{ role: "heading", text: "运行控制台" }]]]),
    });

    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("S-EPIC-01-unit");
    expect(asked[1]).toContain("snapshots");
    expect(result.record.verdict).toBe("accepted");
    expect(result.record.failedScenarios).toEqual([]);
  });

  it("leaves a scenario passing when its snapshot carries what it declared", async () => {
    await mkdir(input().evidencePath, { recursive: true });
    const events = [
      { type: "test_result", scenarioId: "S-EPIC-01-unit", status: "passed" },
      assistant(JSON.stringify({ scenarios: [
        { id: "S-EPIC-01-unit", status: "passed", snapshots: ["page-ok.yml"] },
      ] })),
    ];
    const result = await new BlindVerifyExecutor(
      // Written as the round runs: evidence from before it started is refused,
      // which is what stops a passing snapshot being reused next round.
      { create: () => {
        writeFileSync(join(input().evidencePath, "page-ok.yml"), '- heading "运行控制台" [level=1] [ref=e1]');
        return runner({ events });
      } },
      { insert: async () => undefined },
      pins(),
      roundAround(),
    ).run({
      ...input(),
      visibleRequirements: new Map([["S-EPIC-01-unit", [{ role: "heading", text: "运行控制台" }]]]),
    });

    expect(result.validationErrors).toEqual([]);
    expect(result.record.verdict).toBe("accepted");
    expect(result.record.failedScenarios).toEqual([]);
  });

  it("raises a provider failure instead of recording it as a rejected round", async () => {
    const failing = runner();
    failing.prompt = vi.fn(async (): Promise<PromptResult> => ({
      settled: false,
      failure: { errorMessage: "WebSocket closed 1006 Connection ended", willRetry: false },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
      events: [],
    }));
    const inserted: VerifyRecord[] = [];
    await expect(new BlindVerifyExecutor(
      { create: () => failing },
      { insert: async (record) => { inserted.push(record); } },
      pins(),
    ).run({ ...input(), maxContinueRetries: 0 })).rejects.toThrow(/VERIFY provider failure: .*WebSocket closed/);
    expect(inserted).toHaveLength(0);
  });

  it("fails closed when the verdict never parses, after asking for it again", async () => {
    const instance = runner({ content: "not json" });
    const result = await new BlindVerifyExecutor(
      { create: () => instance },
      { insert: async () => undefined },
      pins(),
    ).run(input());

    expect(result.record.verdict).toBe("inconclusive");
    expect(result.validationErrors.join(" ")).toMatch(/malformed verdict/i);
    expect(instance.prompts).toHaveLength(3);
  });

  it("takes the verdict a second ask produced instead of losing the round", async () => {
    // Re-running the round showed the verifier nothing about what was wrong,
    // so the next attempt repeated the last one and S-R237511TD-01 was parked
    // on retry_limit_exceeded having been judged on nothing.
    const verdict = JSON.stringify({ scenarios: [{ id: "S-EPIC-01-unit", status: "passed" }] });
    const instance = runner({ content: "not json" });
    let call = 0;
    instance.prompt = vi.fn(async (message: string): Promise<PromptResult> => {
      instance.prompts.push(message);
      const content = call++ === 0 ? "I looked at everything and it works." : verdict;
      return {
        settled: true,
        failure: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
        events: [{ type: "test_result", scenarioId: "S-EPIC-01-unit", status: "passed" }, assistant(content)],
      };
    });

    const result = await new BlindVerifyExecutor(
      { create: () => instance },
      { insert: async () => undefined },
      pins(),
    ).run(input());

    expect(result.record.verdict).toBe("accepted");
    expect(instance.prompts).toHaveLength(2);
    expect(instance.prompts[1]).toContain("no verdict this system can read");
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

  it("extracts scenario ids from ANSI-colored test runner output", async () => {
    // vitest wraps glyphs and separators in color codes; the code before the
    // id used to break the word boundary and hide every scenario id.
    const events = [
      {
        type: "message_end",
        message: {
          role: "toolResult",
          content: [{
            type: "text",
            text: " \u001b[32m\u2713\u001b[39m src/util/format.test.ts\u001b[2m > \u001b[22mformatUsd\u001b[2m > \u001b[22mS-EPIC-01-unit rounds correctly 1ms\nTests  1 passed (1)",
          }],
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

  it("says why a scenario the trajectory failed is failed, when the verdict called it passed", async () => {
    const instance = runner({
      events: [
        { type: "test_result", scenarioId: "S-EPIC-01-unit", status: "failed" },
        assistant(JSON.stringify({ scenarios: [{ id: "S-EPIC-01-unit", status: "passed" }] })),
      ],
    });
    const executor = new BlindVerifyExecutor(
      { create: () => instance },
      { insert: async () => undefined },
      pins(),
      (() => { let time = 100; return () => time++; })(),
    );

    const result = await executor.run(input());

    expect(result.record.failedScenarios).toEqual(["S-EPIC-01-unit"]);
    expect(result.reasons).toContainEqual({
      scenarioId: "S-EPIC-01-unit",
      reason: "这条场景在运行记录里判为未通过，但结论里写成通过",
    });
  });
});
