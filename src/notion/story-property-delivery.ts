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
  constructor(private readonly gateway: NotionGateway) {}

  async isApplied(record: NotionOutboxRecord): Promise<boolean> {
    const payload = this.payload(record);
    return await this.observed(payload.pageId) === payload.fingerprint;
  }

  async send(record: NotionOutboxRecord): Promise<void> {
    const payload = this.payload(record);
    const observed = await this.observed(payload.pageId);
    await this.gateway.updatePageProperties({
      pageId: payload.pageId,
      properties: payload.properties,
      fingerprint: payload.fingerprint,
      ...(observed ? { currentFingerprint: observed } : {}),
    });
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
}

/** Routes Story outbox records without allowing either delivery to bypass the gateway. */
export class NotionStoryDelivery implements NotionOutboxDelivery {
  constructor(
    private readonly page: NotionOutboxDelivery,
    private readonly properties: NotionOutboxDelivery,
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
    throw new Error(`unsupported Story outbox operation: ${record.operation}`);
  }
}
