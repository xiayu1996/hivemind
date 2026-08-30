import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { migrate } from "../persistence/migrate.js";
import { NotionGateway } from "./gateway.js";
import schema from "./notion-schema.json" with { type: "json" };
import { NotionOutbox } from "./outbox.js";
import { NotionStoryPropertyDelivery } from "./story-property-delivery.js";

describe("NotionStoryPropertyDelivery", () => {
  it("retires a stale system write without touching Notion during the human-wins window", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 100);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Story",
      requirement: "Requirement",
    });
    await client.execute({
      sql: `UPDATE stories SET notion_ai_status_shadow = ?, human_wins_until = ? WHERE id = ?`,
      args: [schema.options.aiStatus[4]!, 1_000, "S-EPIC1-01"],
    });
    const outbox = new NotionOutbox(client, () => 100);
    await outbox.enqueue({
      cardId: "S-EPIC1-01",
      priority: 1,
      operation: "sync_story_properties",
      target: "story-properties:page-1",
      payload: {
        cardId: "S-EPIC1-01",
        pageId: "page-1",
        fingerprint: "a".repeat(64),
        properties: {
          [schema.propertyNames.aiStatus]: { select: { name: schema.options.aiStatus[0]! } },
        },
      },
    });
    const transport = vi.fn(async () => ({ status: 200, data: {} }));
    const gateway = new NotionGateway({ transport, ratePerSecond: 1_000_000 });
    const delivery = new NotionStoryPropertyDelivery(gateway, client, () => 100);

    await expect(outbox.replay(delivery)).resolves.toEqual({ sent: 1, failed: 0 });
    expect(transport).not.toHaveBeenCalled();
    const row = (await client.execute(
      "SELECT notion_ai_status_shadow FROM stories WHERE id = 'S-EPIC1-01'",
    )).rows[0];
    expect(row?.notion_ai_status_shadow).toBe(schema.options.aiStatus[4]!);
    client.close();
  });
});
