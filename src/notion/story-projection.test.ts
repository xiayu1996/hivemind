import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { parseDoD } from "../pipeline/dod.js";
import { migrate } from "../persistence/migrate.js";
import schema from "./notion-schema.json" with { type: "json" };
import { STORY_BOARD_STATUS } from "./board-status.js";
import { NotionStoryProjection } from "./story-projection.js";

describe("NotionStoryProjection", () => {
  it("shows the phase a stopped card stopped in, not the queue it left long ago", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-EPIC1-01", notionPageId: "page-1", title: "Story", requirement: "Requirement" });
    const projection = new NotionStoryProjection(client, () => 20);
    const phaseOf = async (): Promise<string> => {
      await client.execute("DELETE FROM notion_outbox");
      await projection.enqueue("S-EPIC1-01");
      const row = (await client.execute(
        "SELECT payload FROM notion_outbox WHERE operation = 'sync_story_properties'",
      )).rows[0];
      const payload = JSON.parse(String(row?.payload)) as { properties: Record<string, { select?: { name: string } }> };
      return payload.properties[schema.propertyNames.phase]?.select?.name ?? "";
    };

    expect(await phaseOf()).toBe(schema.options.phase[0]);
    await client.execute("UPDATE stories SET state = 'SPECIFY', phase = 'SPECIFY' WHERE id = 'S-EPIC1-01'");
    expect(await phaseOf()).toBe("\u5199\u6d4b\u8bd5");
    await client.execute(
      "UPDATE stories SET state = 'NEEDS_INPUT', phase = NULL, resume_state = 'VERIFY', stop_reason = 'verify_loop_exceeded' WHERE id = 'S-EPIC1-01'",
    );
    expect(await phaseOf()).toBe("\u9a8c\u8bc1");
    client.close();
  });

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
acceptance_criteria:
  - text: The page is complete.
    scenarios: [S-EPIC1-01-a]
out_of_scope: []
relies_on: []
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
      design: "设计还没写出来。",
      specs: [{ id: "S-EPIC1-01-a", status: "pending" }],
    });
    const property = rows.rows.find((row) => row.operation === "sync_story_properties");
    expect(JSON.parse(String(property?.payload))).toMatchObject({
      pageId: "page-1",
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    client.close();
  });

  it("waits for the Story page to exist and drops projections aimed at the synthetic id", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({
      id: "S-EPIC1-02",
      notionPageId: "synthetic-2",
      title: "Story",
      requirement: "Requirement",
    });
    await client.execute({
      sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
            VALUES ('S-EPIC1-02', 1, 'create_story_page', 'EPIC1', '{}', 'h', 10)`,
    });
    const projection = new NotionStoryProjection(client, () => 20);
    await projection.enqueue("S-EPIC1-02");
    const beforePage = await client.execute("SELECT operation FROM notion_outbox");
    expect(beforePage.rows.map((row) => row.operation)).toEqual(["create_story_page"]);

    // Simulate an older build that projected against the synthetic id, then the page landing.
    await client.execute({
      sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
            VALUES ('S-EPIC1-02', 2, 'sync_story_page', 'story-page:synthetic-2', '{}', 'h2', 11)`,
    });
    await client.execute("UPDATE notion_outbox SET state = 'sent' WHERE operation = 'create_story_page'");
    await client.execute("UPDATE stories SET notion_page_id = 'page-2' WHERE id = 'S-EPIC1-02'");
    await projection.enqueue("S-EPIC1-02");
    const after = await client.execute("SELECT operation, target FROM notion_outbox WHERE state = 'pending' ORDER BY id");
    expect(after.rows.map((row) => row.target)).toEqual([
      "story-page:page-2",
      "story-properties:page-2",
    ]);
    client.close();
  });

  it("tells the board why a verification round was rejected, not only which scenarios failed", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-EPIC1-03", notionPageId: "page-3", title: "Story", requirement: "Requirement" });
    await store.freezeDefinitionOfDone("S-EPIC1-03", parseDoD(`story_id: S-EPIC1-03
design_summary: 保存后能看到规则。
scenarios:
  - id: S-EPIC1-03-a
    title: 保存规则并回显
    given: 管理员打开规则页
    when: 保存一条规则
    then: 列表里出现这条规则
    layers: [integration]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: 规则能保存。
    scenarios: [S-EPIC1-03-a]
out_of_scope: []
relies_on: []
predicted_footprint: [src]
depends_on: []
`));
    await client.execute({
      sql: `INSERT INTO verify_records (card_id, round, code_session_id, verify_session_id, verdict, failed_scenarios, evidence_dir, created_at)
            VALUES ('S-EPIC1-03', 2, 'code.jsonl', 'verify.jsonl', 'rejected', '["S-EPIC1-03-a"]', '/ev', 10)`,
    });
    await client.execute({
      sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
            VALUES ('run-v2', 'S-EPIC1-03', 'VERIFY', 2, ?, 'completed', 5, 10)`,
      args: ["a".repeat(64)],
    });
    await client.execute({
      sql: `INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at)
            VALUES ('run-v2', 'S-EPIC1-03', 'VERIFY', 2, 'verification', ?, 10)`,
      args: [JSON.stringify({
        verdict: "rejected",
        failedScenarios: ["S-EPIC1-03-a"],
        reasons: [{ scenarioId: "S-EPIC1-03-a", reason: "the page at 127.0.0.1:4321 refused the connection" }],
        validationErrors: ["S-EPIC1-03-a: screenshot is missing"],
      })],
    });
    await client.execute("UPDATE stories SET state = 'NEEDS_INPUT', stop_reason = 'verify_loop_exceeded', resume_state = 'VERIFY' WHERE id = 'S-EPIC1-03'");
    await new NotionStoryProjection(client, () => 20).enqueue("S-EPIC1-03");
    const page = (await client.execute("SELECT payload FROM notion_outbox WHERE operation = 'sync_story_page'")).rows[0];
    const desired = JSON.parse(String(page?.payload)).desired;
    expect(desired.verificationRound).toMatchObject({
      round: 2,
      verdict: "rejected",
      passed: 0,
      total: 1,
      rows: [{ scenario: "场景 1 · 保存规则并回显", test: "未通过", screen: "—", note: "" }],
    });
    // A reason written for whoever debugs it is kept, but not in front of the
    // person who only has to decide what to do next.
    expect(desired.technical).toContain("S-EPIC1-03-a：the page at 127.0.0.1:4321 refused the connection");
    expect(desired.technical).toContain("S-EPIC1-03-a: screenshot is missing");
    expect(desired.questions).toContain("这张卡停下了：验证轮次用完。");
    expect(desired.questions).toContain("多半是执行这边的事");
    expect(desired.questions).toContain("从没通过的：场景 1 · 保存规则并回显");
    expect(desired.questions).toContain("回复本页评论");
    expect(desired.metadata).toContain("本段预算 1/6");
    client.close();
  });

  it("writes a status the board has left even when that exact payload was sent once before", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-EPIC1-04", notionPageId: "page-4", title: "Story", requirement: "Requirement" });
    const projection = new NotionStoryProjection(client, () => 20);
    // First stop: the "needs input" properties go out and the shadow follows.
    await client.execute("UPDATE stories SET state = 'NEEDS_INPUT', stop_reason = 'retry_limit_exceeded', resume_state = 'CODE' WHERE id = 'S-EPIC1-04'");
    await projection.enqueue("S-EPIC1-04");
    await client.execute("UPDATE notion_outbox SET state = 'sent', sent_at = 21");
    await client.execute({ sql: "UPDATE stories SET notion_ai_status_shadow = ? WHERE id = 'S-EPIC1-04'", args: [STORY_BOARD_STATUS.needsInput] });
    // A person resumes it; the board now says active.
    await client.execute({ sql: "UPDATE stories SET state = 'CODE', stop_reason = NULL, notion_ai_status_shadow = ? WHERE id = 'S-EPIC1-04'", args: [STORY_BOARD_STATUS.running] });
    // It stops again with byte-identical properties.
    await client.execute("UPDATE stories SET state = 'NEEDS_INPUT', stop_reason = 'retry_limit_exceeded', resume_state = 'CODE' WHERE id = 'S-EPIC1-04'");
    await projection.enqueue("S-EPIC1-04");
    const pending = await client.execute("SELECT operation FROM notion_outbox WHERE state = 'pending' AND operation = 'sync_story_properties'");
    expect(pending.rows).toHaveLength(1);
    client.close();
  });
});

describe("what a person reads on the page", () => {
  it("says what an accepted round verified, and shows the answers that were applied with their author", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-EPIC1-04", notionPageId: "page-4", title: "Story", requirement: "Requirement" });
    await store.freezeDefinitionOfDone("S-EPIC1-04", parseDoD(`story_id: S-EPIC1-04
design_summary: Design.
scenarios:
  - id: S-EPIC1-04-a
    given: A state
    when: projected
    then: it is visible
    layers: [integration]
  - id: S-EPIC1-04-b
    given: A state
    when: projected
    then: it is listed
    layers: [integration]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: The page is complete.
    scenarios: [S-EPIC1-04-a, S-EPIC1-04-b]
out_of_scope: []
relies_on: []
predicted_footprint: [src]
depends_on: []
`));
    await client.execute({
      sql: `INSERT INTO verify_records (card_id, round, code_session_id, verify_session_id, verdict, failed_scenarios, evidence_dir, created_at)
            VALUES ('S-EPIC1-04', 1, 'code.jsonl', 'verify.jsonl', 'accepted', '[]', '/ev', 10)`,
    });
    await client.execute({
      sql: `INSERT INTO ingested_comments (comment_id, page_id, author, body, created_time, ingested_at)
            VALUES ('c-1', 'page-4', 'Claude Code session on behalf of Ryan', 'Use the latest event.', 1757400000000, 10)`,
    });
    await client.execute({
      sql: `INSERT INTO human_feedback (comment_id, card_id, spec_id, round, channel, body, applied_at, applied_round, created_at)
            VALUES ('c-1', 'S-EPIC1-04', 'S-EPIC1-04-a', 7, 'answer', 'Use the latest event.', 12, 8, 11)`,
    });
    await client.execute({
      sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
            VALUES ('run-v1', 'S-EPIC1-04', 'VERIFY', 1, ?, 'completed', 5, 10)`,
      args: ["a".repeat(64)],
    });
    await client.execute({
      sql: `INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at)
            VALUES ('run-v1', 'S-EPIC1-04', 'VERIFY', 1, 'verification', ?, 10)`,
      args: [JSON.stringify({
        verdict: "accepted",
        failedScenarios: [],
        uiReview: { verdict: "accepted", acceptance: [], findings: [], amendments: [], inconclusive: ["S-EPIC1-04-b"] },
      })],
    });
    await new NotionStoryProjection(client, () => 20).enqueue("S-EPIC1-04");
    const page = (await client.execute("SELECT payload FROM notion_outbox WHERE operation = 'sync_story_page'")).rows[0];
    const desired = JSON.parse(String(page?.payload)).desired;
    expect(desired.verificationRound).toMatchObject({
      round: 1,
      verdict: "accepted",
      passed: 2,
      total: 2,
      rows: [
        { scenario: "场景 1 · 场景 1", test: "通过", screen: "—" },
        { scenario: "场景 2 · 场景 2", test: "通过", screen: "无结论" },
      ],
    });
    // Nothing is waiting on a person, so the page says nothing about them.
    expect(desired.metadata).toBeUndefined();
    expect(desired.questions).toBeUndefined();
    expect(desired.answers).toEqual([
      "- Claude Code session on behalf of Ryan（2025-09-09 06:40 UTC，针对 S-EPIC1-04-a，已用于第 8 轮）：Use the latest event.",
    ]);
    client.close();
  });

  it("puts a face on the card that says whether it wants a person", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-EPIC1-01", notionPageId: "page-1", title: "Story", requirement: "Requirement" });
    const projection = new NotionStoryProjection(client, () => 20);

    const iconFor = async (state: string): Promise<string> => {
      await client.execute({ sql: "UPDATE stories SET state = ? WHERE id = 'S-EPIC1-01'", args: [state] });
      await projection.enqueue("S-EPIC1-01");
      const row = (await client.execute(
        "SELECT payload FROM notion_outbox WHERE operation = 'sync_story_properties' ORDER BY id DESC LIMIT 1",
      )).rows[0];
      return (JSON.parse(String(row?.payload)) as { icon: string }).icon;
    };

    expect(await iconFor("NEEDS_INPUT")).toBe("🙋");
    expect(await iconFor("CODE")).toBe("🔧");
    expect(await iconFor("DELIVERED")).toBe("✅");
    expect(await iconFor("HUMAN_PARKED")).toBe("⏸");
    client.close();
  });
});

describe("when a Story asks for a person at all", () => {
  it("speaks for every stop only a person can clear, and stays quiet otherwise", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-EPIC1-09", notionPageId: "page-9", title: "Story", requirement: "Requirement" });
    const projection = new NotionStoryProjection(client, () => 20);

    const callout = async (): Promise<string | undefined> => {
      await client.execute("DELETE FROM notion_outbox");
      await projection.enqueue("S-EPIC1-09");
      const row = (await client.execute(
        "SELECT payload FROM notion_outbox WHERE operation = 'sync_story_page'",
      )).rows[0];
      return (JSON.parse(String(row?.payload)) as { desired: { metadata?: string } }).desired.metadata;
    };

    // Working, and the review request open: the board says where it is, and
    // the page has nothing to ask of anybody.
    for (const state of ["CODE", "VERIFY", "MERGE", "DELIVERED"]) {
      await client.execute({ sql: "UPDATE stories SET state = ?, stop_reason = NULL WHERE id = 'S-EPIC1-09'", args: [state] });
      expect(await callout(), state).toBeUndefined();
    }

    for (const stopReason of ["blocking_question", "verify_loop_exceeded", "retry_limit_exceeded", "cost_ceiling_exceeded"]) {
      await client.execute({
        sql: "UPDATE stories SET state = 'NEEDS_INPUT', stop_reason = ?, resume_state = 'CODE' WHERE id = 'S-EPIC1-09'",
        args: [stopReason],
      });
      // Every one of them tells the person what to do, in their own words.
      expect(await callout(), stopReason).toContain("回复本页评论");
    }

    await client.execute("UPDATE stories SET state = 'FAILED', stop_reason = NULL WHERE id = 'S-EPIC1-09'");
    expect(await callout()).toContain("执行失败");
    client.close();
  });
});
