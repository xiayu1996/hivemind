// oxlint-disable unicorn/no-thenable -- the scenario grammar names a "then" field
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveModel, staticCatalog } from "../runner/model-resolver.js";
import type { PiRunner, PromptResult } from "../runner/types.js";
import { PiPmPort } from "./pi-pm-port.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const MODEL = await resolveModel(staticCatalog([{ provider: "mock", id: "mock-1" }]), "mock", "mock-1");
const REQUIREMENT_ID = "R-abc123def456";

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
    getState: vi.fn(async () => ({ sessionId: "pm-session" })),
    stop: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
  };
}

function port(instance: PiRunner, seen?: Array<Record<string, unknown>>) {
  return new PiPmPort({
    binary: "pi",
    model: MODEL,
    promptRoot: resolve("prompts"),
    cwd: resolve("."),
    createRunner: (config) => {
      seen?.push(config as unknown as Record<string, unknown>);
      return instance;
    },
  });
}

describe("PiPmPort", () => {
  it("asks the clarification contract and hands back the parsed batch", async () => {
    const instance = runner(JSON.stringify({ status: "ask", questions: ["谁会用它？"] }));
    const configs: Array<Record<string, unknown>> = [];

    await expect(port(instance, configs).run({
      requirementId: REQUIREMENT_ID,
      title: "控制台",
      originalRequest: "我想随时知道现在在做什么。",
      history: [{ round: 1, questions: ["先问过的问题？"], answers: ["答过的答案"] }],
      maxQuestions: 6,
      previousRejections: ["question 1 line 1 contains implementation language"],
    })).resolves.toEqual({ status: "ask", questions: ["谁会用它？"] });

    const prompt = instance.prompts[0]!;
    expect(prompt).toContain("需求 id: R-abc123def456");
    expect(prompt).toContain("第 1 轮:");
    expect(prompt).toContain("答 1: 答过的答案");
    expect(prompt).toContain("上一次产出被拒的原因");
    expect(prompt).toContain("一批最多 6 个问题");
  });

  it("runs read-only, on its own baseline, with pi's own context files kept out", async () => {
    const instance = runner(JSON.stringify({ status: "ready", summary: "我明白了" }));
    const configs: Array<Record<string, unknown>> = [];

    await port(instance, configs).run({
      requirementId: REQUIREMENT_ID,
      title: "控制台",
      originalRequest: "我想随时知道现在在做什么。",
      history: [],
      maxQuestions: 6,
      previousRejections: [],
    });

    expect(configs[0]?.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(configs[0]?.contextFiles).toBe("explicit");
    const systemPrompt = configs[0]?.systemPrompt as { mode: string; text: string };
    expect(systemPrompt.mode).toBe("replace");
    expect(systemPrompt.text).toContain("你是 hivemind 的产品经理");
  });

  it("carries the person's revision words into the PRD contract", async () => {
    const candidate = {
      businessGoal: "值班的人随时看到进度",
      nonGoals: [],
      scenarios: [{ id: `${REQUIREMENT_ID}-s01`, given: "打开看板", when: "有卡在等人", then: "看到在等谁" }],
      openQuestions: [],
    };
    const instance = runner(`说明文字\n\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``);

    await expect(port(instance).run({
      requirementId: REQUIREMENT_ID,
      title: "控制台",
      originalRequest: "我想随时知道现在在做什么。",
      history: [],
      revisionFeedback: ["手机上也要能看"],
      previousRejections: [],
    })).resolves.toEqual(candidate);
    expect(instance.prompts[0]).toContain("手机上也要能看");
    expect(instance.prompts[0]).toContain(`场景 id 以 ${REQUIREMENT_ID}- 开头`);
  });

  it("gives the split every scenario it has to cover", async () => {
    const candidate = {
      epics: [{
        id: "CONSOLE1",
        title: "看板首屏",
        businessGoal: "值班的人一眼看到谁在等他",
        body: "打开首屏就能看到全部在等人回答的卡片。",
        scenarioIds: [`${REQUIREMENT_ID}-s01`],
      }],
    };
    const instance = runner(JSON.stringify(candidate));

    await expect(port(instance).run({
      requirementId: REQUIREMENT_ID,
      title: "控制台",
      businessGoal: "值班的人随时看到进度",
      nonGoals: ["这次不做权限"],
      scenarios: [{ id: `${REQUIREMENT_ID}-s01`, given: "打开看板", when: "有卡在等人", then: "看到在等谁" }],
      previousRejections: [],
    })).resolves.toEqual(candidate);
    expect(instance.prompts[0]).toContain("必须全部覆盖的场景");
    expect(instance.prompts[0]).toContain("本次明确不做");
  });

  it("refuses an answer that does not match the contract instead of guessing", async () => {
    const instance = runner("我觉得这个需求挺好的。");

    await expect(port(instance).run({
      requirementId: REQUIREMENT_ID,
      title: "控制台",
      originalRequest: "我想随时知道现在在做什么。",
      history: [],
      maxQuestions: 6,
      previousRejections: [],
    })).rejects.toThrow(/CLARIFY returned nothing/);
  });
});
