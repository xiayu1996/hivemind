import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { parseDoD } from "../pipeline/dod.js";
import { migrate } from "../persistence/migrate.js";
import schema from "./notion-schema.json" with { type: "json" };
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
    expect(desired.verificationRound).toEqual({
      round: 2,
      summary: "rejected; failed: S-EPIC1-03-a | reasons: S-EPIC1-03-a: the page at 127.0.0.1:4321 refused the connection | checks: S-EPIC1-03-a: screenshot is missing",
    });
    expect(desired.questions).toContain("Execution stopped: verify_loop_exceeded. Last verification round 2: rejected");
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
    await client.execute({ sql: "UPDATE stories SET notion_ai_status_shadow = ? WHERE id = 'S-EPIC1-04'", args: [schema.options.aiStatus[2]!] });
    // A person resumes it; the board now says active.
    await client.execute({ sql: "UPDATE stories SET state = 'CODE', stop_reason = NULL, notion_ai_status_shadow = ? WHERE id = 'S-EPIC1-04'", args: [schema.options.aiStatus[1]!] });
    // It stops again with byte-identical properties.
    await client.execute("UPDATE stories SET state = 'NEEDS_INPUT', stop_reason = 'retry_limit_exceeded', resume_state = 'CODE' WHERE id = 'S-EPIC1-04'");
    await projection.enqueue("S-EPIC1-04");
    const pending = await client.execute("SELECT operation FROM notion_outbox WHERE state = 'pending' AND operation = 'sync_story_properties'");
    expect(pending.rows).toHaveLength(1);
    client.close();
  });
});
