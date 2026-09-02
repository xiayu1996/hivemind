import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { CommentIngestor } from "./comment-ingest.js";
import type { NotionGateway } from "./gateway.js";
import { interpretEpicComment, interpretEpicPropertyChange } from "./intent-interpreter.js";
import type { PlanApprovalStore } from "../orchestrator/plan-approval.js";
import type { EpicState } from "../orchestrator/state-machine.js";
import schema from "./notion-schema.json" with { type: "json" };

export interface EpicPropertyPollResult {
  epicId: string;
  intent: "initialized" | "none" | "approve_plan" | "accept_epic" | "unsupported_property_change";
  approved: boolean;
}

export interface EpicCommentPollResult {
  ingested: number;
  approved: number;
  revised: number;
}

function epicState(value: unknown): EpicState {
  if (typeof value !== "string") throw new Error("Epic state is invalid");
  return value as EpicState;
}

function observedEpicStatus(data: unknown, pageId: string): string {
  if (typeof data !== "object" || data === null) throw new Error(`Notion Epic page is invalid: ${pageId}`);
  const properties = (data as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) throw new Error(`Notion Epic has no properties: ${pageId}`);
  const property = (properties as Record<string, unknown>)[schema.propertyNames.epicStatus];
  if (typeof property !== "object" || property === null) throw new Error(`Notion Epic has no status: ${pageId}`);
  const select = (property as { select?: unknown }).select;
  if (typeof select !== "object" || select === null || typeof (select as { name?: unknown }).name !== "string") {
    throw new Error(`Notion Epic has no status: ${pageId}`);
  }
  return (select as { name: string }).name;
}

/** Applies Epic approval input from the same webhook-plus-polling path as Stories. */
export class NotionEpicInputSync {
  constructor(
    private readonly client: Client,
    private readonly gateway: NotionGateway,
    private readonly comments: CommentIngestor,
    private readonly approvals: PlanApprovalStore,
    private readonly now: () => number = Date.now,
  ) {}

  async pollProperties(pageId: string): Promise<EpicPropertyPollResult> {
    const response = await this.gateway.request({
      method: "GET",
      path: `/v1/pages/${encodeURIComponent(pageId)}`,
      priority: "interaction",
    });
    const observed = observedEpicStatus(response.data, pageId);
    const row = (await this.client.execute({
      sql: "SELECT id, state, notion_status_shadow FROM epics WHERE notion_page_id = ?",
      args: [pageId],
    })).rows[0];
    if (!row) throw new Error(`Notion page is not an ingested Epic: ${pageId}`);
    const epicId = String(row.id);
    const internalState = epicState(row.state);
    const shadow = row.notion_status_shadow === null ? schema.options.epicStatus[1]! : String(row.notion_status_shadow);
    if (row.notion_status_shadow === null) {
      await this.client.execute({
        sql: "UPDATE epics SET notion_status_shadow = ? WHERE id = ?",
        args: [shadow, epicId],
      });
      if (shadow === observed) return { epicId, intent: "initialized", approved: false };
    }
    const intent = interpretEpicPropertyChange(shadow, observed, internalState, this.now());
    if (intent.type === "approve_plan") {
      const approved = await this.approvals.approve({
        epicId,
        eventId: `notion-property:${epicId}:${randomUUID()}`,
        source: "drag",
      });
      await this.rememberHumanObservation(epicId, observed, intent.humanWinsUntil);
      return { epicId, intent: "approve_plan", approved };
    }
    // Acceptance is only recorded here; the transition waits for the merge,
    // which EpicCompletion reads together with this observation.
    if (intent.type === "accept_epic" || intent.type === "unsupported_property_change") {
      await this.rememberHumanObservation(epicId, observed, intent.humanWinsUntil);
    }
    return { epicId, intent: intent.type, approved: false };
  }

  async pollComments(pageId: string): Promise<EpicCommentPollResult> {
    const polled = await this.comments.pollPage(pageId);
    const comments = (await this.client.execute({
      sql: `SELECT ic.comment_id, ic.body, e.id AS epic_id, e.state
            FROM ingested_comments ic
            JOIN epics e ON e.notion_page_id = ic.page_id
            LEFT JOIN epic_approval_events a ON a.event_id = ic.comment_id
            WHERE ic.page_id = ? AND a.event_id IS NULL
            ORDER BY ic.created_time, ic.comment_id`,
      args: [pageId],
    })).rows;
    let approved = 0;
    let revised = 0;
    for (const comment of comments) {
      const intent = interpretEpicComment(epicState(comment.state), String(comment.body));
      const epicId = String(comment.epic_id);
      const eventId = String(comment.comment_id);
      if (intent.type === "approve_plan") {
        if (await this.approvals.approve({ epicId, eventId, source: "comment" })) approved++;
      } else if (intent.type === "request_revision") {
        if (await this.approvals.requestRevision(epicId, eventId)) revised++;
      }
    }
    return { ingested: polled.inserted, approved, revised };
  }

  async pollContent(_pageId: string): Promise<void> {
    // Epic plan content is system-projected; human actions arrive via status or comments.
  }

  private async rememberHumanObservation(epicId: string, observed: string, humanWinsUntil: number): Promise<void> {
    const time = this.now();
    await this.client.execute({
      sql: `UPDATE epics SET notion_status_shadow = ?, human_wins_until = ?,
            last_human_action_at = ?, updated_at = ? WHERE id = ?`,
      args: [observed, humanWinsUntil, time, time, epicId],
    });
  }
}
