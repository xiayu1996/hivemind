import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { parseDoD } from "../pipeline/dod.js";
import { migrate } from "../persistence/migrate.js";
import { CommentIngestor, type NotionCommentSource } from "./comment-ingest.js";
import { NotionGateway } from "./gateway.js";
import schema from "./notion-schema.json" with { type: "json" };
import { NotionStoryInputSync } from "./story-input-sync.js";
import type { NotionStoryApi } from "./story-intake.js";

function page(status: string) {
  return {
    properties: {
      [schema.propertyNames.aiStatus]: { type: "select", select: { name: status } },
    },
  };
}

const emptyComments: NotionCommentSource = { listComments: async () => [] };
const emptyApi: NotionStoryApi = {
  queryReady: async () => ({ results: [], hasMore: false, nextCursor: null }),
  listChildren: async () => ({ results: [], hasMore: false, nextCursor: null }),
};

async function story() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const store = new StoryExecutionStore(client, () => 1_000);
  await store.createStory({
    id: "S-EPIC1-01",
    notionPageId: "page-1",
    title: "Story",
    requirement: "Old requirement",
  });
  await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "to-design");
  await store.transition("S-EPIC1-01", "DESIGN", "CODE", "system", "to-code");
  return { client, store };
}

describe("NotionStoryInputSync", () => {
  it("parks and restores a queued Story without violating the central resume-state constraint", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-02",
      notionPageId: "page-2",
      title: "Queued Story",
      requirement: "Requirement",
    });
    let observed = schema.options.aiStatus[4]!;
    const gateway = new NotionGateway({
      ratePerSecond: 1_000_000,
      transport: async () => ({ status: 200, data: page(observed) }),
    });
    const sync = new NotionStoryInputSync(
      client,
      gateway,
      emptyApi,
      new CommentIngestor(client, emptyComments, { now: () => 1_000 }),
      store,
      () => 1_000,
    );

    await sync.pollProperties("page-2");
    await expect(store.getStory("S-EPIC1-02")).resolves.toMatchObject({
      state: "HUMAN_PARKED",
      resumeState: "QUEUED",
    });
    observed = schema.options.aiStatus[0]!;
    await sync.pollProperties("page-2");
    await expect(store.getStory("S-EPIC1-02")).resolves.toMatchObject({ state: "QUEUED", resumeState: null });
    client.close();
  });

  it("persists park/resume intent and the 120 second human-wins window", async () => {
    const { client, store } = await story();
    let observed = schema.options.aiStatus[4]!;
    const gateway = new NotionGateway({
      ratePerSecond: 1_000_000,
      transport: async () => ({ status: 200, data: page(observed) }),
    });
    const sync = new NotionStoryInputSync(
      client,
      gateway,
      emptyApi,
      new CommentIngestor(client, emptyComments, { now: () => 1_000 }),
      store,
      () => 1_000,
    );

    await expect(sync.pollProperties("page-1")).resolves.toMatchObject({ intent: "park" });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      state: "HUMAN_PARKED",
      resumeState: "CODE",
    });
    const parked = (await client.execute(
      "SELECT human_wins_until, last_human_action_at FROM stories WHERE id = 'S-EPIC1-01'",
    )).rows[0];
    expect(parked).toMatchObject({ human_wins_until: 121_000, last_human_action_at: 1_000 });

    observed = schema.options.aiStatus[1]!;
    await expect(sync.pollProperties("page-1")).resolves.toMatchObject({ intent: "resume" });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({ state: "CODE", resumeState: null });
    client.close();
  });

  it("refreshes the human requirement and materializes an anchored answer before resuming", async () => {
    const { client, store } = await story();
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(`story_id: S-EPIC1-01
design_summary: Design.
scenarios:
  - id: S-EPIC1-01-a
    given: A state
    when: answered
    then: work resumes
    layers: [integration]
baseline:
  type: acceptance_test
acceptance_criteria: [Work resumes.]
predicted_footprint: [src]
depends_on: []
`));
    await client.execute("UPDATE story_specs SET notion_block_id = 'spec-1' WHERE spec_id = 'S-EPIC1-01-a'");
    await store.stopForInput("S-EPIC1-01", "CODE", "blocking_question", "stop-1");
    const api: NotionStoryApi = {
      queryReady: emptyApi.queryReady,
      listChildren: async () => ({
        results: [
          {
            id: "requirement-heading",
            type: "heading_2",
            heading_2: { rich_text: [{ plain_text: "\u9700\u6c42\u63cf\u8ff0" }] },
          },
          { id: "requirement-body", type: "paragraph", paragraph: { rich_text: [{ plain_text: "New requirement" }] } },
        ],
        hasMore: false,
        nextCursor: null,
      }),
    };
    const source: NotionCommentSource = {
      listComments: async (targetId, pageId) => targetId === "spec-1" ? [{
        id: "comment-1",
        pageId,
        blockId: "spec-1",
        discussionId: "discussion-1",
        authorId: "user-1",
        body: "Use the existing behavior.",
        createdTime: 900,
      }] : [],
    };
    const comments = new CommentIngestor(client, source, { now: () => 1_000 });
    await comments.registerPage("page-1", ["spec-1"]);
    const gateway = new NotionGateway({
      ratePerSecond: 1_000_000,
      transport: async () => ({ status: 200, data: page(schema.options.aiStatus[2]!) }),
    });
    const sync = new NotionStoryInputSync(client, gateway, api, comments, store, () => 1_000);

    await sync.pollContent("page-1");
    await expect(sync.pollComments("page-1")).resolves.toEqual({ ingested: 1, materialized: 1, resumed: 1 });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      requirement: "New requirement",
      state: "CODE",
      resumeState: null,
    });
    const feedback = (await client.execute(
      "SELECT spec_id, channel, applied_at FROM human_feedback WHERE comment_id = 'comment-1'",
    )).rows[0];
    expect(feedback).toMatchObject({ spec_id: "S-EPIC1-01-a", channel: "answer", applied_at: 1_000 });
    const phaseInput = await store.buildPhaseInput("S-EPIC1-01", "CODE", 1);
    expect(phaseInput.feedback).toContainEqual(expect.objectContaining({
      id: "comment-1",
      specId: "S-EPIC1-01-a",
      body: "Use the existing behavior.",
    }));
    client.close();
  });
});
