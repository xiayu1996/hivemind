import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { parseDoD } from "../pipeline/dod.js";
import { assemblePhasePrompt } from "../pipeline/phase-input.js";
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
  for (const [from, to] of [["QUEUED", "SHAPE"], ["SHAPE", "DESIGN"], ["DESIGN", "SPECIFY"], ["SPECIFY", "CODE"]] as const) {
    await store.transition("S-EPIC1-01", from, to, "system", `to-${to.toLowerCase()}`);
  }
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
acceptance_criteria:
  - text: Work resumes.
    scenarios: [S-EPIC1-01-a]
out_of_scope: []
relies_on: []
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
    await expect(sync.pollComments("page-1")).resolves.toMatchObject({ ingested: 1, materialized: 1, resumed: 1 });
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

  it("treats a page without an AI status as not yet projected instead of failing the poll", async () => {
    const { client, store } = await story();
    const gateway = new NotionGateway({
      ratePerSecond: 1_000_000,
      transport: async () => ({ status: 200, data: { properties: {} } }),
    });
    const sync = new NotionStoryInputSync(
      client,
      gateway,
      emptyApi,
      new CommentIngestor(client, emptyComments, { now: () => 1_000 }),
      store,
      () => 1_000,
    );
    await expect(sync.pollProperties("page-1")).resolves.toEqual({ cardId: "S-EPIC1-01", intent: "initialized" });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({ state: "CODE" });
    client.close();
  });

  it("requeues a Story that stopped before starting when a person drags it back to active", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-03",
      notionPageId: "page-3",
      title: "Never started",
      requirement: "Requirement",
    });
    await store.recordPhaseReentry("S-EPIC1-03");
    await store.recordPhaseReentry("S-EPIC1-03");
    await store.stopForInput("S-EPIC1-03", "QUEUED", "retry_limit_exceeded", "reentry-S-EPIC1-03");
    await client.execute({
      sql: "UPDATE stories SET notion_ai_status_shadow = ? WHERE id = 'S-EPIC1-03'",
      args: [schema.options.aiStatus[2]!],
    });
    const gateway = new NotionGateway({
      ratePerSecond: 1_000_000,
      transport: async () => ({ status: 200, data: page(schema.options.aiStatus[1]!) }),
    });
    const sync = new NotionStoryInputSync(
      client,
      gateway,
      emptyApi,
      new CommentIngestor(client, emptyComments, { now: () => 1_000 }),
      store,
      () => 1_000,
    );
    await expect(sync.pollProperties("page-3")).resolves.toEqual({ cardId: "S-EPIC1-03", intent: "continue_development" });
    await expect(store.getStory("S-EPIC1-03")).resolves.toMatchObject({
      state: "QUEUED",
      stopReason: null,
      phaseReentries: 0,
    });
    client.close();
  });

  it("sends a Story that stopped in MERGE back to CODE when a person drags it to active", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({ id: "S-EPIC1-05", notionPageId: "page-5", title: "Merge stop", requirement: "Requirement" });
    for (const [from, to] of [["QUEUED", "SHAPE"], ["SHAPE", "DESIGN"], ["DESIGN", "SPECIFY"], ["SPECIFY", "CODE"], ["CODE", "VERIFY"], ["VERIFY", "MERGE"]] as const) {
      await store.transition("S-EPIC1-05", from, to, "system", `${from}-${to}`);
    }
    await store.stopForInput("S-EPIC1-05", "MERGE", "retry_limit_exceeded", "reentry-S-EPIC1-05");
    await client.execute({ sql: "UPDATE stories SET notion_ai_status_shadow = ? WHERE id = 'S-EPIC1-05'", args: [schema.options.aiStatus[2]!] });
    const gateway = new NotionGateway({
      ratePerSecond: 1_000_000,
      transport: async () => ({ status: 200, data: page(schema.options.aiStatus[1]!) }),
    });
    const sync = new NotionStoryInputSync(
      client,
      gateway,
      emptyApi,
      new CommentIngestor(client, emptyComments, { now: () => 1_000 }),
      store,
      () => 1_000,
    );
    await expect(sync.pollProperties("page-5")).resolves.toEqual({ cardId: "S-EPIC1-05", intent: "continue_development" });
    await expect(store.getStory("S-EPIC1-05")).resolves.toMatchObject({ state: "CODE", stopReason: null });
    client.close();
  });
});

describe("what a person's comment asks for", () => {
  /** One comment on the page, polled through the real ingest path. */
  async function commented(body: string, blockId?: string) {
    const { client, store } = await story();
    const source: NotionCommentSource = {
      listComments: async (targetId, pageId) => targetId === (blockId ?? pageId) ? [{
        id: "comment-1",
        pageId,
        blockId: blockId ?? null,
        discussionId: "discussion-1",
        authorId: "user-1",
        body,
        createdTime: 900,
      }] : [],
    };
    const comments = new CommentIngestor(client, source, { now: () => 1_000 });
    await comments.registerPage("page-1", blockId ? [blockId] : []);
    const gateway = new NotionGateway({
      ratePerSecond: 1_000_000,
      transport: async () => ({ status: 200, data: page(schema.options.aiStatus[1]!) }),
    });
    const sync = new NotionStoryInputSync(client, gateway, emptyApi, comments, store, () => 1_000);
    return { client, store, sync };
  }

  it("treats an unmarked comment on a running card as material, not as a reason to undo the phase", async () => {
    const { client, store, sync } = await commented("The design doc for this is at wiki/orders.");
    await expect(sync.pollComments("page-1")).resolves.toMatchObject({ resumed: 0, reworked: 0, defects: 0 });

    const feedback = (await client.execute("SELECT channel, applied_at FROM human_feedback")).rows[0];
    expect(feedback).toMatchObject({ channel: "preference", applied_at: null });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({ state: "CODE" });

    // It reaches the next round as context, in its own section and without a tag.
    const input = await store.buildPhaseInput("S-EPIC1-01", "CODE", 4);
    expect(input.supplementaryContext).toMatchObject([{ body: "The design doc for this is at wiki/orders." }]);
    expect(input.feedback).toEqual([]);
    const prompt = assemblePhasePrompt(input);
    expect(prompt).toContain("## Additional context from a person");
    expect(prompt).not.toContain("[answer:comment-1]");
  });

  it("marks the comment used only once a round has actually carried it", async () => {
    const { client, store, sync } = await commented("Prefer the existing colour tokens.");
    await sync.pollComments("page-1");
    expect((await client.execute("SELECT applied_at, applied_round FROM human_feedback")).rows[0])
      .toMatchObject({ applied_at: null, applied_round: null });

    await store.beginPhase({ runId: "run-code-4", cardId: "S-EPIC1-01", phase: "CODE", round: 4, prompt: "code" });
    expect((await client.execute("SELECT applied_at, applied_round FROM human_feedback")).rows[0])
      .toMatchObject({ applied_at: 1_000, applied_round: 4 });
  });

  it("sends a card back to the phase that owns the decision when a person refuses the result", async () => {
    const { client, store, sync } = await commented("rework: the approach fights the existing scheduler");
    await store.beginPhase({ runId: "run-code-1", cardId: "S-EPIC1-01", phase: "CODE", round: 1, prompt: "code" });
    await store.completePhase({ runId: "run-code-1", sessionId: "s-code-1", artifacts: [{ kind: "implementation", body: "x" }] });

    await expect(sync.pollComments("page-1")).resolves.toMatchObject({ reworked: 1, resumed: 0 });
    // CODE's contract returns a refused result to SPECIFY, and the refusal is
    // recorded the same way a failed contract check records one.
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({ state: "SPECIFY" });
    expect(await store.getCompletedPhase("S-EPIC1-01", "CODE", 1)).toBeNull();
    const invalidated = (await client.execute(
      "SELECT data FROM event_log WHERE type = 'phase.invalidated'",
    )).rows[0];
    expect(String(invalidated?.data)).toContain("a person refused this result");
  });

  it("opens a regression card from a defect reported against the scenario the comment sits on", async () => {
    const { client, store, sync } = await commented("defect: the total is wrong when a coupon applies", "spec-1");
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(`story_id: S-EPIC1-01
design_summary: Totals.
scenarios:
  - id: S-EPIC1-01-a
    given: a coupon
    when: the order is priced
    then: the discount is deducted once
    layers: [unit]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: The total is right.
    scenarios: [S-EPIC1-01-a]
out_of_scope: []
relies_on: []
predicted_footprint: []
depends_on: []
`));
    await client.execute("UPDATE story_specs SET notion_block_id = 'spec-1' WHERE spec_id = 'S-EPIC1-01-a'");

    await expect(sync.pollComments("page-1")).resolves.toMatchObject({ defects: 1 });
    const card = (await client.execute("SELECT scenario_id, attributed_story, resolved_at FROM regression_cards")).rows[0];
    expect(card).toMatchObject({ scenario_id: "S-EPIC1-01-a", attributed_story: "S-EPIC1-01", resolved_at: null });
  });

  it("reopens a delivered card into the narrow SPECIFY, the way the sweep does", async () => {
    const { client, store, sync } = await commented("defect: the total is wrong when a coupon applies", "spec-1");
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(`story_id: S-EPIC1-01
design_summary: Totals.
scenarios:
  - id: S-EPIC1-01-a
    given: a coupon
    when: the order is priced
    then: the discount is deducted once
    layers: [unit]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: The total is right.
    scenarios: [S-EPIC1-01-a]
out_of_scope: []
relies_on: []
predicted_footprint: []
depends_on: []
`));
    await client.execute("UPDATE story_specs SET notion_block_id = 'spec-1' WHERE spec_id = 'S-EPIC1-01-a'");
    await client.execute("UPDATE stories SET state = 'DELIVERED', phase = NULL WHERE id = 'S-EPIC1-01'");

    await expect(sync.pollComments("page-1")).resolves.toMatchObject({ defects: 1 });

    // The phase marker is what tells the worker this SPECIFY writes one
    // reproduction rather than a whole test contract.
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      state: "SPECIFY",
      phase: "REGRESSION_FIX",
    });
  });

  it("opens nothing for a defect that names no scenario, rather than guessing which one broke", async () => {
    const { client, sync } = await commented("defect: something is off on that page");
    await expect(sync.pollComments("page-1")).resolves.toMatchObject({ defects: 0 });
    expect((await client.execute("SELECT scenario_id FROM regression_cards")).rows).toEqual([]);
    expect((await client.execute("SELECT applied_at FROM human_feedback")).rows[0]).toMatchObject({ applied_at: null });
  });
});
