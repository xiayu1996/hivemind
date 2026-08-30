import type { Client } from "@libsql/client";
import { z } from "zod";
import type { NotionGateway } from "./gateway.js";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "./outbox.js";
import schema from "./notion-schema.json" with { type: "json" };

const payloadSchema = z.object({
  cardId: z.string().min(1),
  pageId: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  properties: z.record(z.string(), z.unknown()),
});
const pageSchema = z.object({ properties: z.record(z.string(), z.unknown()) }).passthrough();
const richTextSchema = z.object({
  rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()),
}).passthrough();

function currentFingerprint(properties: Record<string, unknown>): string | undefined {
  const parsed = richTextSchema.safeParse(properties[schema.propertyNames.syncFingerprint]);
  if (!parsed.success) return undefined;
  const value = parsed.data.rich_text.map((item) => item.plain_text).join("");
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

/** Applies card-level properties only when their central-truth fingerprint changed. */
export class NotionStoryPropertyDelivery implements NotionOutboxDelivery {
  constructor(
    private readonly gateway: NotionGateway,
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  async isApplied(record: NotionOutboxRecord): Promise<boolean> {
    const payload = this.payload(record);
    if (await this.isSuppressed(payload.cardId)) return true;
    const applied = await this.observed(payload.pageId) === payload.fingerprint;
    if (applied) await this.remember(payload);
    return applied;
  }

  async send(record: NotionOutboxRecord): Promise<void> {
    const payload = this.payload(record);
    if (await this.isSuppressed(payload.cardId)) return;
    const observed = await this.observed(payload.pageId);
    await this.gateway.updatePageProperties({
      pageId: payload.pageId,
      properties: payload.properties,
      fingerprint: payload.fingerprint,
      ...(observed ? { currentFingerprint: observed } : {}),
    });
    await this.remember(payload);
  }

  private payload(record: NotionOutboxRecord): z.infer<typeof payloadSchema> {
    if (record.operation !== "sync_story_properties") {
      throw new Error(`unsupported Notion property operation: ${record.operation}`);
    }
    return payloadSchema.parse(record.payload);
  }

  private async observed(pageId: string): Promise<string | undefined> {
    const response = await this.gateway.request({
      method: "GET",
      path: `/v1/pages/${encodeURIComponent(pageId)}`,
      priority: "status",
    });
    return currentFingerprint(pageSchema.parse(response.data).properties);
  }

  private async isSuppressed(cardId: string): Promise<boolean> {
    const row = (await this.client.execute({
      sql: "SELECT human_wins_until FROM stories WHERE id = ?",
      args: [cardId],
    })).rows[0];
    if (!row) throw new Error(`Story does not exist for Notion projection: ${cardId}`);
    return Number(row.human_wins_until ?? 0) > this.now();
  }

  private async remember(payload: z.infer<typeof payloadSchema>): Promise<void> {
    const status = z.object({ select: z.object({ name: z.string() }) }).safeParse(
      payload.properties[schema.propertyNames.aiStatus],
    );
    if (!status.success) throw new Error("Notion property projection has no AI status");
    await this.client.execute({
      sql: `UPDATE stories SET notion_ai_status_shadow = ? WHERE id = ?`,
      args: [status.data.select.name, payload.cardId],
    });
  }
}

/** Routes Story outbox records without allowing either delivery to bypass the gateway. */
export class NotionStoryDelivery implements NotionOutboxDelivery {
  constructor(
    private readonly page: NotionOutboxDelivery,
    private readonly properties: NotionOutboxDelivery,
    private readonly epicPlan?: NotionOutboxDelivery,
  ) {}

  isApplied(record: NotionOutboxRecord): Promise<boolean> {
    return this.delivery(record).isApplied(record);
  }

  send(record: NotionOutboxRecord): Promise<void> {
    return this.delivery(record).send(record);
  }

  private delivery(record: NotionOutboxRecord): NotionOutboxDelivery {
    if (record.operation === "sync_story_page") return this.page;
    if (record.operation === "sync_story_properties") return this.properties;
    if (this.epicPlan && (record.operation === "present_epic_plan" || record.operation === "create_story_page")) {
      return this.epicPlan;
    }
    // An operation with no delivery would sit pending forever, retried on every
    // cycle, so it is louder to fail here than to let the row rot.
    throw new Error(`unsupported Story outbox operation: ${record.operation}`);
  }
}
