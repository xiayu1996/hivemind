import type { Client } from "@libsql/client";
import { z } from "zod";
import type {
  ClarificationAnswer,
  ClarificationChannel,
  ClarificationQuestionBatch,
} from "../orchestrator/clarification-channel.js";
import type { CommentIngestor } from "./comment-ingest.js";
import type { NotionGateway } from "./gateway.js";

/** Marks the batch a comment belongs to, so a person reading the page later can
 * tell which answers went with which questions. */
export function questionCommentBody(round: number, questions: readonly string[]): string {
  const lines = questions.map((question, index) => `${index + 1}. ${question}`);
  return [`[澄清 第 ${round} 轮]`, ...lines, "", "直接回复这条评论即可，按序号回答最好读。"].join("\n");
}

function mirrorCommentBody(round: number, channelName: string, answers: readonly ClarificationAnswer[]): string {
  const lines = answers.map((answer) => `${answer.author}: ${answer.body}`);
  return [`[澄清 第 ${round} 轮 · 来自${channelName}的回答]`, ...lines].join("\n");
}

/**
 * The requirement page is where clarification actually happens. Questions go
 * out as page comments and answers come back through the comment watermark the
 * rest of the system already uses, so no new plumbing carries the one
 * conversation the whole product manager layer depends on.
 */
export class NotionClarificationChannel implements ClarificationChannel {
  readonly name = "notion";
  readonly isSourceOfTruth = true;

  constructor(
    private readonly client: Client,
    private readonly gateway: NotionGateway,
    private readonly ingestor: CommentIngestor,
    private readonly now: () => number = Date.now,
  ) {}

  async ask(batch: ClarificationQuestionBatch): Promise<void> {
    const pageId = await this.pageId(batch.requirementId);
    await this.ingestor.registerPage(pageId, await this.anchors(batch.requirementId));
    await this.comment(pageId, questionCommentBody(batch.round, batch.questions));
  }

  async collect(requirementId: string, round: number): Promise<ClarificationAnswer[]> {
    const pageId = await this.pageId(requirementId);
    const askedAt = await this.askedAt(requirementId, round);
    if (askedAt === null) return [];
    await this.ingestor.pollPage(pageId);
    const rows = (await this.client.execute({
      sql: `SELECT comment_id, author, body, created_time FROM ingested_comments
            WHERE page_id = ? AND created_time > ? ORDER BY created_time, comment_id`,
      args: [pageId, askedAt],
    })).rows;
    return rows.map((row) => ({
      id: String(row.comment_id),
      author: String(row.author),
      body: String(row.body),
      receivedAt: Number(row.created_time),
    }));
  }

  /**
   * Writes an answer that arrived somewhere else onto the requirement page and
   * into the ingested record. Until both happen the answer does not exist:
   * that is what keeps Notion the only place the conversation can be read.
   */
  async record(requirementId: string, round: number, answers: readonly ClarificationAnswer[]): Promise<void> {
    if (answers.length === 0) return;
    const pageId = await this.pageId(requirementId);
    const askedAt = await this.askedAt(requirementId, round);
    if (askedAt === null) throw new Error(`clarification round ${round} of ${requirementId} was never asked`);
    const posted = await this.comment(pageId, mirrorCommentBody(round, "旁路通道", answers));
    const time = this.now();
    await this.client.batch(answers.map((answer, index) => ({
      sql: `INSERT INTO ingested_comments
              (comment_id, page_id, block_id, discussion_id, author, body, created_time, ingested_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
            ON CONFLICT(comment_id) DO NOTHING`,
      args: [
        `mirror:${posted}:${answer.id}`,
        pageId,
        posted,
        answer.author,
        answer.body,
        Math.max(answer.receivedAt, askedAt + 1 + index),
        time,
      ],
    })), "write");
  }

  private async comment(pageId: string, body: string): Promise<string> {
    const response = await this.gateway.request({
      method: "POST",
      path: "/v1/comments",
      priority: "interaction",
      body: {
        parent: { page_id: pageId },
        rich_text: [{ type: "text", text: { content: body } }],
      },
    });
    return z.object({ id: z.string().min(1) }).parse(response.data).id;
  }

  private async pageId(requirementId: string): Promise<string> {
    const row = (await this.client.execute({
      sql: "SELECT notion_page_id FROM requirements WHERE id = ?",
      args: [requirementId],
    })).rows[0];
    if (!row) throw new Error(`requirement ${requirementId} is not in the central database`);
    return String(row.notion_page_id);
  }

  private async anchors(requirementId: string): Promise<string[]> {
    const rows = (await this.client.execute({
      sql: "SELECT anchor_block_id FROM requirement_notion_sections WHERE requirement_id = ?",
      args: [requirementId],
    })).rows;
    return rows.map((row) => String(row.anchor_block_id));
  }

  private async askedAt(requirementId: string, round: number): Promise<number | null> {
    const row = (await this.client.execute({
      sql: "SELECT asked_at FROM requirement_clarify_rounds WHERE requirement_id = ? AND round = ?",
      args: [requirementId, round],
    })).rows[0];
    return row ? Number(row.asked_at) : null;
  }
}
