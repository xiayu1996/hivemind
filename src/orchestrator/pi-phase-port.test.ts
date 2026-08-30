import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiRunner, PromptResult } from "../runner/types.js";
import { resolveModel } from "../runner/model-resolver.js";
import { PiStoryPhasePort } from "./pi-phase-port.js";
import type { ManagedPhaseInput } from "./story-worker.js";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1, costUsd: 0.1 };

function fakeRunner(reply: string, stateId = "session-1"): PiRunner {
  const result: PromptResult = { settled: true, failure: null, usage, events: [{ type: "agent_settled" }] };
  return {
    alive: true,
    start: vi.fn(async () => undefined),
    prompt: vi.fn(async () => result),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => [{ role: "assistant", content: [{ type: "text", text: reply }] }]),
    getState: vi.fn(async () => ({ sessionId: stateId })),
    setAutoRetry: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
  };
}

function phaseInput(phase: ManagedPhaseInput["phase"]): ManagedPhaseInput {
  return {
    runId: `run-${phase.toLowerCase()}`,
    phase,
    round: 1,
    prompt: "complete the phase",
    context: {
      cardId: "S-EPIC1-01",
      phase,
      round: 1,
      title: "Story",
      requirement: "Requirement",
      specs: [],
      artifacts: [],
      feedback: [],
    previousRejections: [],
      evidence: [],
      failedScenarios: [],
    },
  };
}

describe("PiStoryPhasePort", () => {
  let temporary: string;

  afterEach(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it("injects the guard before spawn and parses a judged DESIGN result", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const reply = JSON.stringify({
      design_summary: "Persist artifacts centrally.",
      dod_yaml: "story_id: S-EPIC1-01",
    });
    const runner = fakeRunner(reply, "fresh-design-session");
    const model = await resolveModel({ list: async () => [{ provider: "mock", id: "mock-1" }] }, "mock", "mock-1");
    const configs: unknown[] = [];
    const telemetry = vi.fn(async () => undefined);
    const port = new PiStoryPhasePort({
      binary: "pi",
      model,
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit", "tool-audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      completionJudge: { complete: async () => JSON.stringify({ done: true, reason: "complete" }) },
      createRunner: (config) => { configs.push(config); return runner; },
      recordTelemetry: telemetry,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    await expect(port.run(phaseInput("DESIGN"))).resolves.toEqual({
      sessionId: "fresh-design-session",
      artifacts: [
        { kind: "design-summary", body: "Persist artifacts centrally." },
        { kind: "dod", body: "story_id: S-EPIC1-01" },
      ],
    });
    expect(configs).toMatchObject([{
      contextFiles: "explicit",
      tools: ["read", "bash"],
      env: { PI_GUARD_POLICY: expect.stringContaining('"phase":"DESIGN"') },
    }]);
    expect(telemetry).toHaveBeenCalledOnce();
  });

  it("fails closed before persistence when the phase output is not the declared JSON contract", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-pi-phase-"));
    const model = await resolveModel({ list: async () => [{ provider: "mock", id: "mock-1" }] }, "mock", "mock-1");
    const port = new PiStoryPhasePort({
      binary: "pi",
      model,
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      completionJudge: { complete: async () => JSON.stringify({ done: true, reason: "complete" }) },
      createRunner: () => fakeRunner("I am done"),
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    await expect(port.run(phaseInput("CODE"))).rejects.toThrow(/invalid JSON/);
  });
});

describe("DESIGN acceptance criteria flattening", () => {
  let temporary: string;

  afterEach(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it("keeps the text of a nested criterion instead of stringifying the object away", async () => {
    temporary = await mkdtemp(join(tmpdir(), "hivemind-dod-"));
    const reply = JSON.stringify({
      design_summary: "Persist artifacts centrally.",
      dod_yaml: {
        story_id: "S-EPIC1-01",
        acceptance_criteria: [
          // oxlint-disable-next-line unicorn/no-thenable -- the DoD grammar names this field
          { given: { customer: "has a coupon" }, then: "the discount is deducted once" },
        ],
      },
    });
    const model = await resolveModel({ list: async () => [{ provider: "mock", id: "mock-1" }] }, "mock", "mock-1");
    const port = new PiStoryPhasePort({
      binary: "pi",
      model,
      worktreePath: resolve("."),
      promptRoot: resolve("prompts"),
      sessionRoot: join(temporary, "sessions"),
      evidencePath: join(temporary, "evidence"),
      auditPath: join(temporary, "audit", "tool-audit.jsonl"),
      guardExtension: resolve("extensions/hive-guard.ts"),
      canonicalCaptureExtension: resolve("extensions/canonical-capture.ts"),
      completionJudge: { complete: async () => JSON.stringify({ done: true, reason: "complete" }) },
      createRunner: () => fakeRunner(reply, "fresh-design-session"),
      recordTelemetry: async () => undefined,
      readProviderPayloads: async () => [{ model: "mock-1", messages: [] }],
    });

    const result = await port.run(phaseInput("DESIGN"));
    const dod = result.artifacts.find((item) => item.kind === "dod")?.body ?? "";
    expect(dod).not.toContain("[object Object]");
    expect(dod).toContain("has a coupon");
    expect(dod).toContain("the discount is deducted once");
  });
});
