import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { z } from "zod";
import type { AcceptanceChecklist } from "../orchestrator/acceptance-checklist.js";
import type { RequirementStore } from "../orchestrator/requirement-store.js";
import type { CommentIngestor } from "./comment-ingest.js";
import type { NotionGateway } from "./gateway.js";
import { interpretRequirementComment, interpretRequirementPropertyChange } from "./intent-interpreter.js";
import schema from "./notion-schema.json" with { type: "json" };

export interface RequirementPropertyPollResult {
  requirementId: string;
  intent: "initialized" | "none" | "approve_prd" | "accept" | "park" | "resume" | "unsupported_property_change";
  applied: boolean;
}

export interface RequirementCommentPollResult {
  ingested: number;
  prdConfirmed: boolean;
  revisionRequested: boolean;
  gapsRecorded: number;
}

export interface RequirementContentPollResult {
  ticked: number;
}

const pageSchema = z.object({ properties: z.record(z.string(), z.unknown()) }).passthrough();
const selectSchema = z.object({ select: z.object({ name: z.string() }).nullable() });
const toDoSchema = z.object({ to_do: z.object({ checked: z.boolean() }).passthrough() }).passthrough();

function runId(requirementId: string): string {
  return `requirement:${requirementId}`;
}

/**
 * Reads what a person did on their requirement page and turns it into the
 * three inputs the product manager layer accepts from them: a verdict on the
 * PRD, a verdict on each acceptance scenario, and parking. Clarification
 * answers are not read here; the clarification channel owns those.
 *
 * Every decision is claimed under an event id before it acts, so the same
 * comment or tick seen by a webhook and by the fallback poll counts once.
 */
export class NotionRequirementInputSync {
  constructor(
    private readonly client: Client,
    private readonly gateway: NotionGateway,
    private readonly comments: CommentIngestor,
    private readonly store: RequirementStore,
    private readonly checklist: AcceptanceChecklist,
    private readonly now: () => number = Date.now,
  ) {}

  async pollProperties(requirementId: string): Promise<RequirementPropertyPollResult> {
    const requirement = await this.store.getRequirement(requirementId);
    const response = await this.gateway.request({
      method: "GET",
      path: `/v1/pages/${encodeURIComponent(requirement.notionPageId)}`,
      priority: "interaction",
    });
    const observed = selectSchema.parse(
      pageSchema.parse(response.data).properties[schema.propertyNames.requirementStatus],
    ).select?.name;
    if (!observed) return { requirementId, intent: "none", applied: false };

    const row = (await this.client.execute({
      sql: "SELECT notion_status_shadow FROM requirements WHERE id = ?",
      args: [requirementId],
    })).rows[0];
    if (row?.notion_status_shadow === null) {
      // The first look establishes what the column showed before anyone acted;
      // reading it as a drag would apply a change nobody made.
      await this.client.execute({
        sql: "UPDATE requirements SET notion_status_shadow = ? WHERE id = ?",
        args: [observed, requirementId],
      });
      return { requirementId, intent: "initialized", applied: false };
    }
    const shadow = String(row?.notion_status_shadow);
    const intent = interpretRequirementPropertyChange(
      shadow,
      observed,
      requirement.state,
      requirement.resumeState ?? undefined,
      this.now(),
    );
    if (intent.type === "none") return { requirementId, intent: "none", applied: false };

    let applied = false;
    if (intent.type === "approve_prd") {
      const prd = await this.store.getPrd(requirementId);
      if (prd?.status === "draft") {
        applied = await this.store.confirmPrd(
          requirementId, prd.revision, `notion-property:${requirementId}:${randomUUID()}`, "drag", runId(requirementId),
        );
      }
    } else if (intent.type === "accept") {
      // Dragging the whole card to accepted is a verdict on every scenario
      // still waiting for one.
      for (const item of await this.store.acceptanceItems(requirementId)) {
        if (item.status !== "open") continue;
        applied = (await this.store.decideAcceptanceItem(
          requirementId, item.itemId, "accepted",
          `notion-property:${requirementId}:${item.itemId}:${randomUUID()}`, "drag", runId(requirementId),
        )) || applied;
      }
    } else if (intent.type === "park") {
      await this.store.transition(requirementId, requirement.state, "HUMAN_PARKED", "human", runId(requirementId));
      applied = true;
    } else if (intent.type === "resume") {
      await this.store.transition(requirementId, "HUMAN_PARKED", intent.state, "human", runId(requirementId), intent.state);
      applied = true;
    }
    await this.client.execute({
      sql: `UPDATE requirements SET notion_status_shadow = ?, human_wins_until = ?,
            last_human_action_at = ?, updated_at = ? WHERE id = ?`,
      args: [observed, intent.humanWinsUntil, this.now(), this.now(), requirementId],
    });
    return { requirementId, intent: intent.type, applied };
  }

  async pollComments(requirementId: string): Promise<RequirementCommentPollResult> {
    const requirement = await this.store.getRequirement(requirementId);
    const pageId = requirement.notionPageId;
    const anchors = (await this.client.execute({
      sql: "SELECT anchor_block_id FROM requirement_notion_sections WHERE requirement_id = ?",
      args: [requirementId],
    })).rows.map((row) => String(row.anchor_block_id));
    const boxes = (await this.store.acceptanceItems(requirementId))
      .flatMap((item) => item.notionBlockId ? [item.notionBlockId] : []);
    await this.comments.registerPage(pageId, [...anchors, ...boxes]);
    const polled = await this.comments.pollPage(pageId);
    const result: RequirementCommentPollResult = {
      ingested: polled.inserted, prdConfirmed: false, revisionRequested: false, gapsRecorded: 0,
    };

    if (requirement.state === "PRD_CONFIRM") {
      const draft = (await this.client.execute({
        sql: `SELECT revision, created_at FROM requirement_prds
              WHERE requirement_id = ? AND status = 'draft' ORDER BY revision DESC LIMIT 1`,
        args: [requirementId],
      })).rows[0];
      if (!draft) return result;
      const revision = Number(draft.revision);
      const unclaimed = await this.unclaimedComments(pageId, Number(draft.created_at));
      const revisions: Array<{ id: string; body: string }> = [];
      for (const comment of unclaimed) {
        const intent = interpretRequirementComment("PRD_CONFIRM", comment.body);
        if (intent.type === "approve_prd" && revisions.length === 0) {
          result.prdConfirmed = await this.store.confirmPrd(requirementId, revision, comment.id, "comment", runId(requirementId));
          break;
        }
        if (intent.type === "request_revision") revisions.push({ id: comment.id, body: intent.body });
      }
      if (!result.prdConfirmed && revisions.length > 0) {
        // Everything the person wrote about this draft travels together into
        // the rewrite; one comment superseding the draft must not drop the rest.
        const [first, ...rest] = revisions;
        result.revisionRequested = await this.store.requestPrdRevision(
          requirementId, revision, revisions.map((item) => item.body).join("\n"), first!.id, "comment", runId(requirementId),
        );
        for (const item of rest) await this.store.claimApprovalEvent(requirementId, item.id, "prd_revision", "comment");
      }
      return result;
    }

    if (requirement.state === "ACCEPTANCE") {
      const items = await this.store.acceptanceItems(requirementId);
      for (const comment of await this.unclaimedComments(pageId, 0)) {
        if (!comment.blockId) continue;
        const item = items.find((candidate) => candidate.notionBlockId === comment.blockId && candidate.status === "open");
        if (!item) continue;
        if (await this.checklist.recordGap(requirementId, item.itemId, comment.body, comment.id, "comment")) {
          result.gapsRecorded++;
          item.status = "gap";
        }
      }
    }
    return result;
  }

  /** A ticked box is the one input that lives in page content rather than in
   * a comment or a property. */
  async pollContent(requirementId: string): Promise<RequirementContentPollResult> {
    const requirement = await this.store.getRequirement(requirementId);
    const result: RequirementContentPollResult = { ticked: 0 };
    if (requirement.state !== "ACCEPTANCE") return result;
    for (const item of await this.store.acceptanceItems(requirementId)) {
      if (item.status !== "open" || !item.notionBlockId) continue;
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/blocks/${encodeURIComponent(item.notionBlockId)}`,
        priority: "interaction",
      });
      const block = toDoSchema.safeParse(response.data);
      if (!block.success || !block.data.to_do.checked) continue;
      if (await this.checklist.applyCheck(requirementId, item.notionBlockId, true, `notion-tick:${item.notionBlockId}`, "drag")) {
        result.ticked++;
      }
    }
    return result;
  }

  private async unclaimedComments(pageId: string, after: number): Promise<Array<{ id: string; blockId: string | null; body: string }>> {
    const rows = (await this.client.execute({
      sql: `SELECT ic.comment_id, ic.block_id, ic.body FROM ingested_comments ic
            LEFT JOIN requirement_approval_events a ON a.event_id = ic.comment_id
            WHERE ic.page_id = ? AND ic.created_time > ? AND a.event_id IS NULL
            ORDER BY ic.created_time, ic.comment_id`,
      args: [pageId, after],
    })).rows;
    return rows.map((row) => ({
      id: String(row.comment_id),
      blockId: row.block_id === null ? null : String(row.block_id),
      body: String(row.body),
    }));
  }
}
