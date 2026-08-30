// oxlint-disable unicorn/no-thenable -- the scenario grammar names a "then" field
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveModel, staticCatalog } from "../runner/model-resolver.js";
import type { PiRunner, PromptResult } from "../runner/types.js";
import { PiDecomposePort } from "./pi-decompose-port.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const MODEL = await resolveModel(staticCatalog([{ provider: "mock", id: "mock-1" }]), "mock", "mock-1");

const CANDIDATE = {
  epicId: "M2",
  businessGoal: "客户在一次评审里看到整个提案。",
  stories: [{
    id: "S-M2-01",
    title: "客户看到提案概要",
    requirement: "客户打开提案时先看到整体结论。",
    scenarios: [{ id: "S-M2-01-a", given: "客户收到提案", when: "客户打开提案", then: "客户先看到整体结论" }],
    dependsOn: [],
    predictedFootprint: ["src/orchestrator"],
  }],
};

function runner(reply: string): PiRunner & { prompts: string[] } {
  const prompts: string[] = [];
  const result: PromptResult = { settled: true, failure: null, usage, events: [] };
  return {
    prompts,
    alive: true,
    start: vi.fn(async () => undefined),
    setAutoRetry: vi.fn(async () => undefined),
    prompt: vi.fn(async (message: string) => { prompts.push(message); return result; }),
    getMessages: vi.fn(async () => [{ role: "assistant", content: [{ type: "text", text: reply }] }]),
    getState: vi.fn(async () => ({ sessionId: "decompose-session" })),
    stop: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
  };
}

function port(instance: PiRunner) {
  return new PiDecomposePort({
    binary: "pi",
    model: MODEL,
    promptRoot: resolve("prompts"),
    cwd: resolve("."),
    createRunner: () => instance,
  });
}

describe("PiDecomposePort", () => {
  it("asks with the decomposition contract and returns the parsed candidate", async () => {
    const instance = runner(JSON.stringify(CANDIDATE));

    await expect(port(instance).run({
      epicId: "M2",
      title: "并行与回归",
      requirement: "多个 Story 并行推进并合成一次评审。",
      previousRejections: [],
    })).resolves.toMatchObject({ epicId: "M2", stories: [{ id: "S-M2-01" }] });

    const prompt = (instance as unknown as { prompts: string[] }).prompts[0]!;
    expect(prompt).toContain("多个 Story 并行推进并合成一次评审。");
    expect(prompt).toContain("并行与回归");
  });

  it("shows the model why its previous attempt was refused", async () => {
    const instance = runner(JSON.stringify(CANDIDATE));

    await port(instance).run({
      epicId: "M2",
      title: "并行与回归",
      requirement: "需求",
      previousRejections: ["businessGoal 含实现词汇", "S-M2-02 缺少场景"],
    });

    const prompt = (instance as unknown as { prompts: string[] }).prompts[0]!;
    expect(prompt).toContain("businessGoal 含实现词汇");
    expect(prompt).toContain("S-M2-02 缺少场景");
  });

  it("finds the candidate inside prose or a code fence", async () => {
    const instance = runner(`思考完毕。\n\`\`\`json\n${JSON.stringify(CANDIDATE)}\n\`\`\``);
    await expect(port(instance).run({ epicId: "M2", title: "t", requirement: "r", previousRejections: [] }))
      .resolves.toMatchObject({ epicId: "M2" });
  });

  it("fails closed when the reply carries no usable candidate", async () => {
    const instance = runner("我需要更多信息才能回答。");
    await expect(port(instance).run({ epicId: "M2", title: "t", requirement: "r", previousRejections: [] }))
      .rejects.toThrow(/DECOMPOSE/);
  });

  it("stops the session even when the reply was unusable", async () => {
    const instance = runner("not json");
    await port(instance).run({ epicId: "M2", title: "t", requirement: "r", previousRejections: [] }).catch(() => undefined);
    expect(instance.stop).toHaveBeenCalled();
  });
});
