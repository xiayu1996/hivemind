import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { parseDoD } from "../pipeline/dod.js";
import { migrate } from "../persistence/migrate.js";
import { NotionStoryProjection } from "./story-projection.js";

describe("NotionStoryProjection", () => {
  it("queues a complete central-truth projection and deduplicates an unchanged page", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Story",
      requirement: "Requirement",
    });
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(`story_id: S-EPIC1-01
design_summary: Design.
scenarios:
  - id: S-EPIC1-01-a
    given: A state
    when: projected
    then: it is visible
    layers: [integration]
baseline:
  type: acceptance_test
acceptance_criteria: [The page is complete.]
predicted_footprint: [src]
depends_on: []
`));
    const projection = new NotionStoryProjection(client, () => 20);
    await projection.enqueue("S-EPIC1-01");
    await projection.enqueue("S-EPIC1-01");
    const rows = await client.execute("SELECT operation, target, payload FROM notion_outbox");
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "sync_story_page", target: "story-page:page-1" }),
      expect.objectContaining({ operation: "sync_story_properties", target: "story-properties:page-1" }),
    ]));
    const page = rows.rows.find((row) => row.operation === "sync_story_page");
    const payload = JSON.parse(String(page?.payload));
    expect(payload.desired).toMatchObject({
      design: "Design is pending.",
      specs: [{ id: "S-EPIC1-01-a", status: "pending" }],
    });
    const property = rows.rows.find((row) => row.operation === "sync_story_properties");
    expect(JSON.parse(String(property?.payload))).toMatchObject({
      pageId: "page-1",
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    client.close();
  });
});
