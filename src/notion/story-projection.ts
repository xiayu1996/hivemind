import type { Client } from "@libsql/client";
import type { StoryProjectionPort } from "../orchestrator/story-worker.js";
import { NotionOutbox, payloadHash } from "./outbox.js";
import type { DesiredStoryPage } from "./blocks/story-page.js";
import schema from "./notion-schema.json" with { type: "json" };

function value(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function richText(content: string): Record<string, unknown> {
  return { rich_text: [{ type: "text", text: { content } }] };
}

function aiStatus(state: string): string {
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
    now: () => number = Date.now,
  ) {
    this.outbox = new NotionOutbox(client, now);
  }

  async enqueue(cardId: string): Promise<void> {
    const storyResult = await this.client.execute({
      sql: `SELECT notion_page_id, state, phase, inner_loop_rounds, stop_reason, mr_url
            FROM stories WHERE id = ?`,
      args: [cardId],
    });
    const story = storyResult.rows[0];
    if (!story) throw new Error(`Story does not exist: ${cardId}`);
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
    const desired: DesiredStoryPage = {
      metadata: [
        `Task ${cardId}`,
        `State ${String(story.state)}`,
        `Round ${Number(story.inner_loop_rounds)}`,
        `Cost $${Number(cost.rows[0]?.total ?? 0).toFixed(4)}`,
        ...(story.mr_url ? [`MR ${String(story.mr_url)}`] : []),
      ].join(" · "),
      design: value(design.rows[0]?.body) || "Design is pending.",
      ...(story.stop_reason ? { questions: `Execution stopped: ${String(story.stop_reason)}` } : {}),
      specs: specs.rows.map((row) => ({
        id: String(row.spec_id),
        seq: Number(row.seq),
        status: String(row.status),
        text: String(row.text),
      })),
      ...(latest ? {
        verificationRound: {
          round: Number(latest.round),
          summary: `${String(latest.verdict)}; failed: ${JSON.parse(String(latest.failed_scenarios)).join(", ") || "none"}`,
        },
      } : {}),
    };
    await this.outbox.enqueue({
      cardId,
      priority: 2,
      operation: "sync_story_page",
      target: `story-page:${String(story.notion_page_id)}`,
      payload: {
        cardId,
        pageId: String(story.notion_page_id),
        desired,
      },
    });
    const names = schema.propertyNames;
    const properties: Record<string, unknown> = {
      [names.aiStatus]: { select: { name: aiStatus(String(story.state)) } },
      [names.phase]: { select: { name: phase(String(story.state)) } },
      [names.cost]: { number: Number(cost.rows[0]?.total ?? 0) },
      [names.rounds]: { number: Number(story.inner_loop_rounds) },
      [names.mergeRequest]: { url: story.mr_url ? String(story.mr_url) : null },
    };
    const fingerprint = payloadHash(properties).hash;
    properties[names.syncFingerprint] = richText(fingerprint);
    await this.outbox.enqueue({
      cardId,
      priority: 1,
      operation: "sync_story_properties",
      target: `story-properties:${String(story.notion_page_id)}`,
      payload: {
        cardId,
        pageId: String(story.notion_page_id),
        fingerprint,
        properties,
      },
    });
  }
}
