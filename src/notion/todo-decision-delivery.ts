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
  throw new Error(`the todo decision delivery is not implemented yet (${deps.gateway ? "gateway given" : "no gateway"})`);
}
