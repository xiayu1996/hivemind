import { describe, expect, it } from "vitest";
import {
  ClarificationChannelSet,
  type ClarificationAnswer,
  type ClarificationChannel,
  type ClarificationQuestionBatch,
} from "./clarification-channel.js";

class RecordingChannel implements ClarificationChannel {
  readonly asked: ClarificationQuestionBatch[] = [];
  readonly answers = new Map<string, ClarificationAnswer[]>();

  constructor(readonly name: string, readonly isSourceOfTruth: boolean) {}

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

function answer(id: string): ClarificationAnswer {
  return { id, author: "person", body: "值班的人每天早上看一次", receivedAt: 1_000 };
}

describe("ClarificationChannelSet", () => {
  it("refuses a set without exactly one record", () => {
    expect(() => new ClarificationChannelSet([])).toThrow(/exactly one source of truth/);
    expect(() => new ClarificationChannelSet([
      new RecordingChannel("notion", true),
      new RecordingChannel("chat", true),
    ])).toThrow(/exactly one source of truth/);
  });

  it("asks every channel but reads only the record", async () => {
    const notion = new RecordingChannel("notion", true);
    const chat = new RecordingChannel("chat", false);
    const set = new ClarificationChannelSet([notion, chat]);

    await set.ask({ requirementId: "R-1", round: 1, questions: [{ question: "谁会用？", options: [] }] });
    expect(notion.asked).toHaveLength(1);
    expect(chat.asked).toHaveLength(1);

    await chat.record("R-1", 1, [answer("chat-1")]);
    await expect(set.collect("R-1", 1)).resolves.toEqual([]);
  });

  it("makes a side-channel answer real only once it is written back to the record", async () => {
    const notion = new RecordingChannel("notion", true);
    const chat = new RecordingChannel("chat", false);
    const set = new ClarificationChannelSet([notion, chat]);
    await chat.record("R-1", 1, [answer("chat-1")]);

    await expect(set.mirrorToRecord("R-1", 1, "chat")).resolves.toBe(1);
    await expect(set.collect("R-1", 1)).resolves.toMatchObject([{ id: "chat-1" }]);
  });

  it("names an unknown channel instead of silently mirroring nothing", async () => {
    const set = new ClarificationChannelSet([new RecordingChannel("notion", true)]);
    await expect(set.mirrorToRecord("R-1", 1, "feishu")).rejects.toThrow(/unknown clarification channel/);
  });
});
