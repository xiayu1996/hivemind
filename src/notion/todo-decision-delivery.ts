import { z } from "zod";
import { TODO_DECISION_OPERATION } from "../orchestrator/todo-decision.js";
import type { NotionGateway } from "./gateway.js";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "./outbox.js";

/**
 * Puts a person's decision on the Notion entry that has to keep it.
 *
 * The comments are appended, never merged into the page body: the body is
 * system-owned and rebuilt whole by the projections, so words written into it
 * would be gone on the next publish. Appending is also what the lanes that
 * read the decision already watch -- they read comments.
 *
 * `isApplied` asks the page whether the comments are already there, by text,
 * because an append cannot be told from a retry by its result. That is what
 * makes a replay after a crash safe: the row is only marked sent when every
 * comment is visible, and a partially posted decision is completed rather than
 * duplicated.
 */

export const TODO_DECISION_OUTBOX_OPERATIONS = [TODO_DECISION_OPERATION] as const;

const payloadSchema = z.object({
  todoId: z.string().min(1),
  pageId: z.string().min(1),
  /** In the order a person reads them. */
  comments: z.array(z.object({
    body: z.string().min(1),
    /** Repeated here only so the record step does not have to re-read the
     * decision row; the delivery itself posts every comment either way. */
    mirror: z.boolean(),
  })).min(1),
});

const commentListSchema = z.object({
  results: z.array(z.object({
    rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()),
  }).passthrough()),
  has_more: z.boolean().optional(),
  next_cursor: z.string().nullable().optional(),
}).passthrough();

export type TodoDecisionPayload = z.infer<typeof payloadSchema>;

export interface TodoDecisionDelivery extends NotionOutboxDelivery {
  /** The bodies of this payload that the page does not carry yet, in order. */
  missing(record: NotionOutboxRecord): Promise<readonly string[]>;
}

export function createTodoDecisionDelivery(deps: {
  gateway: NotionGateway;
  /** Injected only so a test can answer what a page already carries. */
  listComments?: ((pageId: string) => Promise<readonly string[]>) | undefined;
}): TodoDecisionDelivery {
  const listComments = deps.listComments ?? ((pageId: string) => readCommentBodies(deps.gateway, pageId));

  async function missing(record: NotionOutboxRecord): Promise<readonly string[]> {
    const payload = payloadSchema.parse(record.payload);
    const present = [...await listComments(payload.pageId)];
    const wanted: string[] = [];
    for (const comment of payload.comments) {
      const at = present.indexOf(comment.body);
      // Consuming a match is what makes two identical comments two comments:
      // the second one is not already on the page just because the first is.
      if (at === -1) wanted.push(comment.body);
      else present.splice(at, 1);
    }
    return wanted;
  }

  return {
    missing,
    async isApplied(record) {
      return (await missing(record)).length === 0;
    },
    async send(record) {
      const payload = payloadSchema.parse(record.payload);
      for (const body of await missing(record)) {
        await deps.gateway.request({
          method: "POST",
          path: "/v1/comments",
          priority: "interaction",
          body: { parent: { page_id: payload.pageId }, rich_text: [{ type: "text", text: { content: body } }] },
        });
      }
    },
  };
}

/** The bodies the page carries now, paginated. The decision's own text is the
 * only marker Notion gives an append, so a retry compares text rather than
 * asking the API whether it saw this request before. */
async function readCommentBodies(gateway: NotionGateway, pageId: string): Promise<readonly string[]> {
  const bodies: string[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ block_id: pageId, page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const response = await gateway.request({
      method: "GET",
      path: `/v1/comments?${query.toString()}`,
      priority: "interaction",
    });
    const page = commentListSchema.parse(response.data);
    for (const item of page.results) {
      bodies.push(item.rich_text.map((part) => part.plain_text).join(""));
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
  return bodies;
}
