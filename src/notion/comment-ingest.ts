import type { Client, InStatement } from "@libsql/client";

const OVERLAP_MS = 2 * 60 * 1_000;

export interface NotionComment {
  id: string;
  pageId: string;
  blockId: string | null;
  discussionId: string | null;
  authorId: string;
  body: string;
  createdTime: number;
}

export interface NotionCommentSource {
  /** Returns all currently visible, unresolved comments for a page or block. */
  listComments(targetId: string, pageId: string): Promise<NotionComment[]>;
}

export interface CommentIngestOptions {
  now?: () => number;
  botUserId?: string;
}

export interface CommentPollResult {
  inserted: number;
  maxCreatedTime: number;
}

export class CommentIngestor {
  readonly #now: () => number;
  readonly #botUserId: string | undefined;

  constructor(
    private readonly client: Client,
    private readonly source: NotionCommentSource,
    options: CommentIngestOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#botUserId = options.botUserId;
  }

  async registerPage(pageId: string, anchorBlockIds: readonly string[]): Promise<void> {
    const anchors = [...new Set(anchorBlockIds)].toSorted((a, b) => a.localeCompare(b, "en"));
    await this.client.execute({
      sql: `INSERT INTO comment_watermark (page_id, max_created_time, anchor_block_ids)
            VALUES (?, 0, ?)
            ON CONFLICT(page_id) DO UPDATE SET anchor_block_ids = excluded.anchor_block_ids`,
      args: [pageId, JSON.stringify(anchors)],
    });
  }

  async pollPage(pageId: string): Promise<CommentPollResult> {
    const watermark = (await this.client.execute({
      sql: "SELECT max_created_time, anchor_block_ids FROM comment_watermark WHERE page_id = ?",
      args: [pageId],
    })).rows[0];
    if (!watermark) throw new Error(`comment page is not registered: ${pageId}`);
    const currentMax = Number(watermark.max_created_time);
    const anchors = JSON.parse(String(watermark.anchor_block_ids)) as string[];
    const targets = [pageId, ...anchors.toSorted((a, b) => a.localeCompare(b, "en"))];
    const collected: NotionComment[] = [];
    for (const target of targets) collected.push(...await this.source.listComments(target, pageId));

    const byId = new Map<string, NotionComment>();
    for (const item of collected) {
      if (item.pageId === pageId && !byId.has(item.id)) byId.set(item.id, item);
    }
    const comments = [...byId.values()].toSorted(
      (a, b) => a.createdTime - b.createdTime || a.id.localeCompare(b.id, "en"),
    );
    const maxCreatedTime = comments.reduce(
      (maximum, item) => Math.max(maximum, item.createdTime),
      currentMax,
    );
    const cutoff = currentMax === 0 ? Number.NEGATIVE_INFINITY : currentMax - OVERLAP_MS;
    const eligible = comments.filter(
      (item) => item.createdTime >= cutoff && item.authorId !== this.#botUserId,
    );

    const statements: InStatement[] = eligible.map((item) => ({
      sql: `INSERT INTO ingested_comments
              (comment_id, page_id, block_id, discussion_id, author, body, created_time, ingested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(comment_id) DO NOTHING`,
      args: [
        item.id,
        item.pageId,
        item.blockId,
        item.discussionId,
        item.authorId,
        item.body,
        item.createdTime,
        this.#now(),
      ],
    }));
    statements.push({
      sql: `UPDATE comment_watermark
            SET max_created_time = ?, last_polled_at = ?
            WHERE page_id = ?`,
      args: [maxCreatedTime, this.#now(), pageId],
    });
    const results = await this.client.batch(statements, "write");
    const inserted = results.slice(0, -1).reduce((total, result) => total + result.rowsAffected, 0);
    return { inserted, maxCreatedTime };
  }
}
