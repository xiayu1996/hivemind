import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import {
  ClarificationChannelSet,
  type ClarificationAnswer,
  type ClarificationChannel,
  type ClarificationQuestionBatch,
} from "./clarification-channel.js";
import { ClarifyLoop, type ClarifyPort, type ClarifyRequest } from "./clarify-loop.js";
import { RequirementStore } from "./requirement-store.js";
import type { ClarificationCandidate } from "./requirement-artifacts.js";

const REQUIREMENT_ID = "R-abc123def456";

class PageChannel implements ClarificationChannel {
  readonly name = "notion";
  readonly isSourceOfTruth = true;
  readonly asked: ClarificationQuestionBatch[] = [];
  private readonly answers = new Map<string, ClarificationAnswer[]>();

  async ask(batch: ClarificationQuestionBatch): Promise<void> {
    this.asked.push(batch);
  }

  async collect(requirementId: string, round: number): Promise<ClarificationAnswer[]> {
    return this.answers.get(`${requirementId}#${round}`) ?? [];
  }

  async record(requirementId: string, round: number, answers: readonly ClarificationAnswer[]): Promise<void> {
    const key = `${requirementId}#${round}`;
    this.answers.set(key, [...(this.answers.get(key) ?? []), ...answers]);
  }
}

class ScriptedPort implements ClarifyPort {
  readonly requests: ClarifyRequest[] = [];
  constructor(private readonly replies: ClarificationCandidate[]) {}

  async run(input: ClarifyRequest): Promise<ClarificationCandidate> {
    this.requests.push(input);
    const reply = this.replies.shift();
    if (!reply) throw new Error("the product manager was asked more times than the test scripted");
    return reply;
  }
}

describe("ClarifyLoop", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let channel: PageChannel;
  let published: string[];

  function loop(port: ClarifyPort, maxRounds = 5): ClarifyLoop {
    return new ClarifyLoop(
      store,
      new ClarificationChannelSet([channel]),
      port,
      { publish: async (id: string) => { published.push(id); } },
      { maxRounds, maxQuestionsPerRound: 6 },
    );
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    store = new RequirementStore(client, () => time++);
    channel = new PageChannel();
    published = [];
    await store.createRequirement({
      id: REQUIREMENT_ID,
      notionPageId: "requirement-page",
      title: "给 hivemind 做一个控制台",
      originalRequest: "我想随时知道现在在做什么。",
    });
  });

  afterEach(() => client.close());

  it("converges after two rounds of questions", async () => {
    const port = new ScriptedPort([
      { status: "ask", questions: ["谁会用它？"] },
      { status: "ask", questions: ["他希望多久看到一次更新？"] },
      { status: "ready", summary: "值班的人要随时看到每张卡进行到哪一步" },
    ]);
    const clarify = loop(port);

    await expect(clarify.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "asked", round: 1 });
    await expect(clarify.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "waiting", round: 1 });

    await channel.record(REQUIREMENT_ID, 1, [
      { id: "c1", author: "提需求的人", body: "值班的人", receivedAt: 10 },
    ]);
    await expect(clarify.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "answered", round: 1 });
    await expect(clarify.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "asked", round: 2 });

    await channel.record(REQUIREMENT_ID, 2, [
      { id: "c2", author: "提需求的人", body: "每天早上一次就够", receivedAt: 20 },
    ]);
    await clarify.advance(REQUIREMENT_ID);
    await expect(clarify.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "ready" });

    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "PRD_CONFIRM" });
    expect(channel.asked.map((batch) => batch.round)).toEqual([1, 2]);
    expect(published.length).toBeGreaterThan(0);
  });

  it("archives the answer verbatim, attributed to whoever wrote it", async () => {
    const clarify = loop(new ScriptedPort([{ status: "ask", questions: ["谁会用它？"] }]));
    await clarify.advance(REQUIREMENT_ID);
    await channel.record(REQUIREMENT_ID, 1, [
      { id: "c2", author: "第二个人", body: "还有交付经理", receivedAt: 20 },
      { id: "c1", author: "提需求的人", body: "值班的人", receivedAt: 10 },
    ]);

    await clarify.advance(REQUIREMENT_ID);

    await expect(store.clarifyHistory(REQUIREMENT_ID)).resolves.toMatchObject([
      { round: 1, answers: ["提需求的人: 值班的人", "第二个人: 还有交付经理"] },
    ]);
  });

  it("sends the options out with the question and records what the chosen letter meant", async () => {
    const clarify = loop(new ScriptedPort([{
      status: "ask",
      questions: [
        { question: "谁会用它？", options: [{ label: "值班的人", recommended: true }, { label: "交付经理" }] },
        "现在这件事是怎么解决的？",
      ],
    }]));
    await clarify.advance(REQUIREMENT_ID);
    expect(channel.asked[0]?.questions).toEqual([
      { question: "谁会用它？", options: [{ label: "值班的人", recommended: true }, { label: "交付经理" }] },
      { question: "现在这件事是怎么解决的？", options: [] },
    ]);

    await channel.record(REQUIREMENT_ID, 1, [{ id: "c1", author: "提需求的人", body: "1B，2 靠人工翻群消息", receivedAt: 10 }]);
    await clarify.advance(REQUIREMENT_ID);

    await expect(store.clarifyHistory(REQUIREMENT_ID)).resolves.toMatchObject([
      { round: 1, answers: ["提需求的人: 1B，2 靠人工翻群消息\n（系统解读：问 1 选 B = 交付经理）"] },
    ]);
  });

  it("hands the requirement to a person when the question budget runs out", async () => {
    const port = new ScriptedPort([
      { status: "ask", questions: ["第一个问题？"] },
      { status: "ask", questions: ["还有一个问题？"] },
    ]);
    const clarify = loop(port, 1);

    await expect(clarify.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "asked", round: 1 });
    await channel.record(REQUIREMENT_ID, 1, [{ id: "c1", author: "人", body: "值班的人", receivedAt: 10 }]);
    await clarify.advance(REQUIREMENT_ID);

    const outcome = await clarify.advance(REQUIREMENT_ID);
    expect(outcome).toMatchObject({ kind: "stopped" });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({
      state: "CLARIFY",
      stopReason: "blocking_question",
    });
    expect(channel.asked).toHaveLength(1);
  });

  it("gives the product manager its rejection reasons before giving up on it", async () => {
    const port = new ScriptedPort([
      { status: "ask", questions: ["前端组件用哪个？"] },
      { status: "ask", questions: ["数据库表怎么设计？"] },
    ]);
    const clarify = loop(port);

    await expect(clarify.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "stopped" });
    expect(port.requests[1]?.previousRejections[0]).toContain("implementation language");
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ stopReason: "blocking_question" });
    expect(channel.asked).toEqual([]);
  });

  it("refuses to run on a requirement that already left clarification", async () => {
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-1");
    await expect(loop(new ScriptedPort([])).advance(REQUIREMENT_ID)).rejects.toThrow(/not in clarification/);
  });
});
