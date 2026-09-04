import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClarificationChannelSet } from "../orchestrator/clarification-channel.js";
import { RequirementStore } from "../orchestrator/requirement-store.js";
import { migrate } from "../persistence/migrate.js";
import { CommentIngestor, type NotionComment, type NotionCommentSource } from "./comment-ingest.js";
import { NotionGateway, type NotionTransport } from "./gateway.js";
import { NotionClarificationChannel } from "./notion-clarification-channel.js";

const REQUIREMENT_ID = "R-abc123def456";
const PAGE_ID = "requirement-page";

class FakeCommentSource implements NotionCommentSource {
  readonly comments: NotionComment[] = [];

  async listComments(): Promise<NotionComment[]> {
    return [...this.comments];
  }
}

describe("NotionClarificationChannel", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let source: FakeCommentSource;
  let channel: NotionClarificationChannel;
  let posted: Array<{ pageId: string; body: string }>;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    store = new RequirementStore(client, () => time++);
    source = new FakeCommentSource();
    posted = [];
    let commentId = 1;
    const transport: NotionTransport = async (request) => {
      if (request.method === "POST" && request.path === "/v1/comments") {
        const body = request.body as {
          parent: { page_id: string };
          rich_text: Array<{ text: { content: string } }>;
        };
        posted.push({ pageId: body.parent.page_id, body: body.rich_text[0]!.text.content });
        return { status: 200, data: { object: "comment", id: `comment-${commentId++}` } };
      }
      return { status: 404, data: {} };
    };
    const gateway = new NotionGateway({ transport, ratePerSecond: 1_000_000, mergeWindowMs: 0 });
    const ingestor = new CommentIngestor(client, source, { now: () => 9_000, botUserId: "bot" });
    channel = new NotionClarificationChannel(client, gateway, ingestor, () => 9_000);
    await store.createRequirement({
      id: REQUIREMENT_ID,
      notionPageId: PAGE_ID,
      title: "给 hivemind 做一个控制台",
      originalRequest: "我想随时知道现在在做什么。",
    });
  });

  afterEach(() => client.close());

  it("posts the batch as one readable comment naming its round", async () => {
    const round = await store.openClarifyRound(REQUIREMENT_ID, ["谁会用它？", "多久看一次？"], "run-ask");
    await channel.ask({ requirementId: REQUIREMENT_ID, round, questions: [{ question: "谁会用它？", options: [] }, { question: "多久看一次？", options: [] }] });

    expect(posted).toHaveLength(1);
    expect(posted[0]?.pageId).toBe(PAGE_ID);
    expect(posted[0]?.body).toContain("[澄清 第 1 轮]");
    expect(posted[0]?.body).toContain("1. 谁会用它？");
    expect(posted[0]?.body).toContain("2. 多久看一次？");
    expect(posted[0]?.body).toContain("按序号回答");
  });

  it("lists each question's options under it and explains the letter reply", async () => {
    const questions = [
      { question: "谁会用它？", options: [{ label: "值班的人", recommended: true }, { label: "交付经理" }] },
      { question: "多久看一次？", options: [{ label: "实时" }, { label: "每天一次" }] },
    ];
    const round = await store.openClarifyRound(REQUIREMENT_ID, questions, "run-ask");
    await channel.ask({ requirementId: REQUIREMENT_ID, round, questions });

    expect(posted[0]?.body.split("\n")).toEqual([
      "[澄清 第 1 轮]",
      "1. 谁会用它？",
      "   A. 值班的人（推荐）",
      "   B. 交付经理",
      "   其他：以上都不合适，直接写你的答案",
      "2. 多久看一次？",
      "   A. 实时",
      "   B. 每天一次",
      "   其他：以上都不合适，直接写你的答案",
      "",
      expect.stringContaining("1A 2B"),
    ]);
  });

  it("reads back only what a person wrote after the questions went out", async () => {
    const round = await store.openClarifyRound(REQUIREMENT_ID, ["谁会用它？"], "run-ask");
    const askedAt = (await store.clarifyHistory(REQUIREMENT_ID))[0]!.askedAt;
    await channel.ask({ requirementId: REQUIREMENT_ID, round, questions: [{ question: "谁会用它？", options: [] }] });
    source.comments.push(
      { id: "old", pageId: PAGE_ID, blockId: null, discussionId: null, authorId: "person", body: "早先的闲聊", createdTime: askedAt - 1 },
      { id: "bot-echo", pageId: PAGE_ID, blockId: null, discussionId: null, authorId: "bot", body: "[澄清 第 1 轮]", createdTime: askedAt + 1 },
      { id: "answer", pageId: PAGE_ID, blockId: null, discussionId: null, authorId: "person", body: "值班的人", createdTime: askedAt + 2 },
    );

    await expect(channel.collect(REQUIREMENT_ID, round)).resolves.toMatchObject([
      { id: "answer", author: "person", body: "值班的人" },
    ]);
  });

  it("makes a side-channel answer real by writing it onto the page and into the record", async () => {
    const round = await store.openClarifyRound(REQUIREMENT_ID, ["谁会用它？"], "run-ask");
    await channel.ask({ requirementId: REQUIREMENT_ID, round, questions: [{ question: "谁会用它？", options: [] }] });
    const set = new ClarificationChannelSet([channel, {
      name: "chat",
      isSourceOfTruth: false,
      ask: async () => undefined,
      collect: async () => [{ id: "chat-1", author: "提需求的人", body: "值班的人", receivedAt: 50 }],
    }]);

    await expect(set.collect(REQUIREMENT_ID, round)).resolves.toEqual([]);
    await expect(set.mirrorToRecord(REQUIREMENT_ID, round, "chat")).resolves.toBe(1);

    expect(posted.at(-1)?.body).toContain("提需求的人: 值班的人");
    await expect(set.collect(REQUIREMENT_ID, round)).resolves.toMatchObject([
      { author: "提需求的人", body: "值班的人" },
    ]);
  });
});
