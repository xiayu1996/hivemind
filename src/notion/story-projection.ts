import type { Client } from "@libsql/client";
import type { StoryProjectionPort } from "../orchestrator/story-worker.js";
import { NotionOutbox, payloadHash } from "./outbox.js";
import type { DesiredStoryPage } from "./blocks/story-page.js";
import schema from "./notion-schema.json" with { type: "json" };

/** Notion caps a rich text run at 2000 characters. */
const SUMMARY_LIMIT = 1900;

function value(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function richText(content: string): Record<string, unknown> {
  return { rich_text: [{ type: "text", text: { content } }] };
}

export function notionAiStatusForState(state: string): string {
  const options = schema.options.aiStatus;
  if (state === "NEEDS_INPUT") return options[2]!;
  if (state === "HUMAN_PARKED") return options[4]!;
  if (state === "DELIVERED") return options[5]!;
  if (state === "FAILED") return options[6]!;
  return state === "QUEUED" ? options[0]! : options[1]!;
}

function phase(state: string): string {
  const options = schema.options.phase;
  if (state === "DESIGN") return options[1]!;
  if (state === "CODE" || state === "REGRESSION_FIX") return options[2]!;
  if (state === "VERIFY") return options[3]!;
  if (state === "MERGE" || state === "DELIVERED") return options[5]!;
  return options[0]!;
}

/** Builds a complete desired page from central truth and durably queues the projection. */
export class NotionStoryProjection implements StoryProjectionPort {
  private readonly outbox: NotionOutbox;

  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {
    this.outbox = new NotionOutbox(client, this.now);
  }

  private async pageCreationPending(cardId: string): Promise<boolean> {
    const row = (await this.client.execute({
      sql: `SELECT 1 FROM notion_outbox
            WHERE card_id = ? AND operation = 'create_story_page' AND state = 'pending'`,
      args: [cardId],
    })).rows[0];
    return row !== undefined;
  }

  /** Pending projections queued against a page id the Story no longer has
   * (the synthetic one from before the page existed) can never be delivered. */
  private async dropStaleTargets(cardId: string, pageId: string): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM notion_outbox
            WHERE card_id = ? AND state = 'pending'
              AND operation IN ('sync_story_page', 'sync_story_properties')
              AND target NOT IN (?, ?)`,
      args: [cardId, `story-page:${pageId}`, `story-properties:${pageId}`],
    });
  }

  /** One line a person can act on: the verdict, the failed set, and the
   * verifier's reasons plus the code-level checks that rejected the round. */
  private async roundSummary(cardId: string, latest: Record<string, unknown>): Promise<string> {
    const failed = JSON.parse(String(latest.failed_scenarios)) as string[];
    const parts = [`${String(latest.verdict)}; failed: ${failed.join(", ") || "none"}`];
    const artifact = (await this.client.execute({
      sql: `SELECT body FROM phase_artifacts
            WHERE card_id = ? AND phase = 'VERIFY' AND kind = 'verification' AND round = ?
            ORDER BY id DESC LIMIT 1`,
      args: [cardId, Number(latest.round)],
    })).rows[0];
    if (artifact) {
      const body = JSON.parse(String(artifact.body)) as {
        reasons?: Array<{ scenarioId: string; reason: string }>;
        validationErrors?: string[];
        uiReview?: { findings?: Array<{ severity: string; note: string }> };
      };
      const reasons = (body.reasons ?? []).map((item) => `${item.scenarioId}: ${item.reason}`);
      if (reasons.length > 0) parts.push(`reasons: ${reasons.join("; ")}`);
      if ((body.validationErrors ?? []).length > 0) parts.push(`checks: ${body.validationErrors!.join("; ")}`);
      // The UI review's findings never rejected anything, so they would leave
      // no trace in the verdict; a person still has to be told they exist and
      // that the card was not held for them.
      const findings = body.uiReview?.findings ?? [];
      if (findings.length > 0) {
        const major = findings.find((finding) => finding.severity === "major");
        parts.push(`界面走查 ${findings.length} 条（不影响验收）${major ? `，例如: ${major.note}` : ""}`);
      }
    }
    const summary = parts.join(" | ");
    return summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT - 1)}…` : summary;
  }

  async enqueue(cardId: string): Promise<void> {
    const storyResult = await this.client.execute({
      sql: `SELECT notion_page_id, state, phase, inner_loop_rounds, stop_reason, mr_url,
                   human_wins_until, notion_ai_status_shadow
            FROM stories WHERE id = ?`,
      args: [cardId],
    });
    const story = storyResult.rows[0];
    if (!story) throw new Error(`Story does not exist: ${cardId}`);
    // The approval gate inserts a Story with a synthetic page id before Notion
    // has a page; projecting against it can only 404 and would poison the outbox.
    if (await this.pageCreationPending(cardId)) return;
    const pageId = String(story.notion_page_id);
    await this.dropStaleTargets(cardId, pageId);
    const [specs, design, verification, cost] = await Promise.all([
      this.client.execute({
        sql: "SELECT spec_id, seq, status, text FROM story_specs WHERE story_id = ? ORDER BY seq",
        args: [cardId],
      }),
      this.client.execute({
        sql: `SELECT body FROM phase_artifacts
              WHERE card_id = ? AND kind = 'design-summary'
              ORDER BY round DESC, id DESC LIMIT 1`,
        args: [cardId],
      }),
      this.client.execute({
        sql: `SELECT round, verdict, failed_scenarios FROM verify_records
              WHERE card_id = ? ORDER BY round DESC LIMIT 1`,
        args: [cardId],
      }),
      this.client.execute({
        sql: "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_entries WHERE card_id = ?",
        args: [cardId],
      }),
    ]);
    const latest = verification.rows[0];
    const roundSummary = latest ? await this.roundSummary(cardId, latest) : undefined;
    const stopText = story.stop_reason
      ? `Execution stopped: ${String(story.stop_reason)}` +
        (roundSummary && String(story.stop_reason) === "verify_loop_exceeded"
          ? `. Last verification round ${Number(latest!.round)}: ${roundSummary}`
          : "")
      : undefined;
    const desired: DesiredStoryPage = {
      metadata: [
        `Task ${cardId}`,
        `State ${String(story.state)}`,
        `Round ${Number(story.inner_loop_rounds)}`,
        `Cost $${Number(cost.rows[0]?.total ?? 0).toFixed(4)}`,
        ...(story.mr_url ? [`MR ${String(story.mr_url)}`] : []),
      ].join(" · "),
      design: value(design.rows[0]?.body) || "Design is pending.",
      ...(stopText ? { questions: stopText } : {}),
      specs: specs.rows.map((row) => ({
        id: String(row.spec_id),
        seq: Number(row.seq),
        status: String(row.status),
        text: String(row.text),
      })),
      ...(latest && roundSummary ? {
        verificationRound: { round: Number(latest.round), summary: roundSummary },
      } : {}),
    };
    await this.outbox.enqueue({
      cardId,
      priority: 2,
      operation: "sync_story_page",
      target: `story-page:${pageId}`,
      payload: {
        cardId,
        pageId,
        desired,
      },
    });
    const names = schema.propertyNames;
    const aiStatus = notionAiStatusForState(String(story.state));
    const properties: Record<string, unknown> = {
      [names.aiStatus]: { select: { name: aiStatus } },
      [names.phase]: { select: { name: phase(String(story.state)) } },
      [names.cost]: { number: Number(cost.rows[0]?.total ?? 0) },
      [names.rounds]: { number: Number(story.inner_loop_rounds) },
      [names.mergeRequest]: { url: story.mr_url ? String(story.mr_url) : null },
    };
    const fingerprint = payloadHash(properties).hash;
    properties[names.syncFingerprint] = richText(fingerprint);
    if (Number(story.human_wins_until ?? 0) <= this.now()) {
      // The board shows the last status we wrote (the shadow). When it differs
      // from what the state now calls for, the page must be written even if
      // this exact payload went out once before an intermediate state.
      const boardDisagrees = story.notion_ai_status_shadow !== null && String(story.notion_ai_status_shadow) !== aiStatus;
      await this.outbox.enqueue({
        cardId,
        priority: 1,
        operation: "sync_story_properties",
        target: `story-properties:${pageId}`,
        payload: {
          cardId,
          pageId,
          fingerprint,
          properties,
        },
        ...(boardDisagrees ? { resend: true } : {}),
      });
    }
  }
}
