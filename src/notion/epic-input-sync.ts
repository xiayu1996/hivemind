import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { CommentIngestor } from "./comment-ingest.js";
import type { NotionGateway } from "./gateway.js";
import { interpretEpicComment, interpretEpicPropertyChange } from "./intent-interpreter.js";
import { judgeApprovals, renderMovedApprovals, type ApprovalJudgeSettings } from "../judge/approval-intent.js";
import { answerBlocker } from "../orchestrator/epic-blocker.js";
import type { PlanApprovalStore } from "../orchestrator/plan-approval.js";
import { EpicAcceptance } from "../orchestrator/epic-acceptance.js";
import type { EpicState } from "../orchestrator/state-machine.js";
import schema from "./notion-schema.json" with { type: "json" };
import { z } from "zod";

const toDoSchema = z.object({ to_do: z.object({ checked: z.boolean() }).passthrough() }).passthrough();

export interface EpicPropertyPollResult {
  epicId: string;
  intent: "initialized" | "none" | "approve_plan" | "accept_epic" | "unsupported_property_change";
  approved: boolean;
}

export interface EpicCommentPollResult {
  ingested: number;
  approved: number;
  revised: number;
  /** Blocking questions a person answered, sending the Epic back to decomposition. */
  answered: number;
  /** Scenarios a person said this batch did not deliver. */
  gaps: number;
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
    private readonly acceptance: EpicAcceptance = new EpicAcceptance(client, now),
    /** Left out where there is no credential; the whitelist then answers alone. */
    private readonly approvalJudge: ApprovalJudgeSettings | undefined = undefined,
    /** How often the whitelist missed an approval, so the question earns its
     * place on measurement rather than on the argument that made it. */
    private readonly recordFriction:
      | ((input: { cardId: string; runId: string; kind: string; detail: string }) => Promise<void>)
      | undefined = undefined,
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
      sql: `SELECT ic.comment_id, ic.block_id, ic.body, e.id AS epic_id, e.state
            FROM ingested_comments ic
            JOIN epics e ON e.notion_page_id = ic.page_id
            LEFT JOIN epic_approval_events a ON a.event_id = ic.comment_id
            WHERE ic.page_id = ? AND a.event_id IS NULL
            ORDER BY ic.created_time, ic.comment_id`,
      args: [pageId],
    })).rows;
    const approving = await this.judgeApprovals(comments);
    const waiting: { epicId: string; eventId: string; body: string }[] = [];
    let approved = 0;
    let revised = 0;
    let answered = 0;
    let gaps = 0;
    for (const comment of comments) {
      const state = epicState(comment.state);
      const epicId = String(comment.epic_id);
      const eventId = String(comment.comment_id);
      // On a blocked Epic the person's next words are the answer; nothing else
      // is being asked of them there.
      if (state === "BLOCKED") {
        if (await answerBlocker(this.client, epicId, eventId, String(comment.body), this.now)) answered++;
        continue;
      }
      // A comment written on one of the acceptance boxes is what that box is
      // for: the person saying what this batch did not deliver.
      if (state === "EPIC_ACCEPT" && comment.block_id !== null) {
        const item = (await this.acceptance.items(epicId))
          .find((candidate) => candidate.notionBlockId === String(comment.block_id) && candidate.status === "open");
        if (item) {
          if (await this.acceptance.recordGap(epicId, item.prdScenarioId, String(comment.body))) gaps++;
          continue;
        }
      }
      const intent = interpretEpicComment(state, String(comment.body), approving);
      if (intent.type === "approve_plan" && waiting.length === 0) {
        if (await this.approvals.approve({ epicId, eventId, source: "comment" })) approved++;
        continue;
      }
      // Everything the person wrote about this plan travels together into the
      // next split, and an approval written after a request to change
      // something is not an approval of what is on the page now.
      if (intent.type === "request_revision" || intent.type === "approve_plan") {
        waiting.push({ epicId, eventId, body: intent.type === "request_revision" ? intent.body : "" });
      }
    }
    if (waiting.length > 0) {
      const [first, ...rest] = waiting;
      const feedback = waiting.map((item) => item.body).filter((body) => body !== "").join("\n");
      // One request carrying every comment, and every comment spent: one left
      // unclaimed would send the next plan back the moment it arrives.
      if (await this.approvals.requestRevision(first!.epicId, first!.eventId, feedback, rest.map((item) => item.eventId))) {
        revised++;
      }
    }
    return { ingested: polled.inserted, approved, revised, answered, gaps };
  }

  /**
   * Asks the judge about the plan-approval comments the whitelist did not read
   * as approvals, and about nothing else. On this page an unrecognised comment
   * falls through to `feedback`, which is silence: the Epic goes on waiting and
   * the person is never told their approval was not understood. The judge can
   * only turn one of those into an approval; it never turns an approval back.
   */
  private async judgeApprovals(
    comments: readonly Record<string, unknown>[],
  ): Promise<ReadonlySet<string>> {
    const settings = this.approvalJudge;
    if (!settings?.judge) return new Set();
    const waiting = comments.filter((comment) => {
      const state = epicState(comment.state);
      return state === "PLAN_APPROVAL"
        && interpretEpicComment(state, String(comment.body)).type !== "approve_plan";
    });
    if (waiting.length === 0) return new Set();
    const judgement = await judgeApprovals(
      settings.judge,
      waiting.map((comment) => String(comment.body)),
      "decomposition plan",
      { model: settings.model, threshold: settings.threshold },
    );
    if (judgement.moved.length > 0) {
      const epicId = String(waiting[0]!.epic_id);
      await this.recordFriction?.({
        cardId: epicId,
        runId: `epic:${epicId}`,
        kind: "notion_approval_judged",
        detail: renderMovedApprovals(judgement.moved),
      });
    }
    return judgement.approving;
  }

  /**
   * The acceptance boxes: a tick is the one verdict that lives in page content
   * rather than in a comment or a property. An unticked box is the absence of
   * a verdict, never a rejection -- that has to be said in words.
   */
  async pollContent(pageId: string): Promise<{ ticked: number }> {
    const row = (await this.client.execute({
      sql: "SELECT id, state FROM epics WHERE notion_page_id = ?",
      args: [pageId],
    })).rows[0];
    if (!row || epicState(row.state) !== "EPIC_ACCEPT") return { ticked: 0 };
    const epicId = String(row.id);
    let ticked = 0;
    for (const item of await this.acceptance.items(epicId)) {
      if (item.status !== "open" || !item.notionBlockId) continue;
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/blocks/${encodeURIComponent(item.notionBlockId)}`,
        priority: "interaction",
      });
      const block = toDoSchema.safeParse(response.data);
      if (!block.success || !block.data.to_do.checked) continue;
      if (await this.acceptance.applyCheck(epicId, item.notionBlockId)) ticked++;
    }
    return { ticked };
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
