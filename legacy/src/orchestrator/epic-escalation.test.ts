import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { answerBlocker, latestBlock, surfaceBlockedEpics } from "./epic-blocker.js";
import { escalateParkedStories } from "./epic-escalation.js";

let client: Client;

async function epic(id: string, state: string): Promise<void> {
  await client.execute({
    sql: "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
    args: [id, `page-${id}`, `Epic ${id}`, state],
  });
}

async function story(id: string, epicId: string, state: string, stopReason: string | null = null): Promise<void> {
  await client.execute({
    sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'do the thing', ?, ?, 1, 1)`,
    args: [id, epicId, `page-${id}`, `Story ${id}`, state, stopReason],
  });
}

async function epicState(id: string): Promise<string> {
  return String((await client.execute({ sql: "SELECT state FROM epics WHERE id = ?", args: [id] })).rows[0]?.state);
}

async function transitions(id: string): Promise<Record<string, unknown>[]> {
  const rows = (await client.execute({
    sql: "SELECT data FROM event_log WHERE run_id = ? AND type = 'epic.transition' ORDER BY seq",
    args: [`epic:${id}`],
  })).rows;
  return rows.map((row) => JSON.parse(String(row.data)) as Record<string, unknown>);
}

async function headFailing(epicId: string, storyId: string, ts = 50): Promise<void> {
  await client.execute({
    sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
          VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                  NULL, NULL, 'epic.head_failing', ?, ?)`,
    args: [`epic:${epicId}`, `epic:${epicId}`, ts, JSON.stringify({
      storyId, headSha: "beef2", check: "npm test",
      failures: ["src/runner/catalog-snapshot.test.ts > deepseek"],
    })],
  });
}

async function headRecovered(epicId: string, ts = 60): Promise<void> {
  await client.execute({
    sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
          VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                  NULL, NULL, 'epic.head_recovered', ?, ?)`,
    args: [`epic:${epicId}`, `epic:${epicId}`, ts, JSON.stringify({ check: "npm test", headSha: "cafe3" })],
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

afterEach(() => client.close());

describe("escalateParkedStories", () => {
  it("counts a parked or failed Story as stuck, because neither moves without a person", async () => {
    await epic("E1", "EXECUTING");
    await story("S-E1-01", "E1", "HUMAN_PARKED");
    await epic("E2", "EXECUTING");
    await story("S-E2-01", "E2", "FAILED");

    const changes = await escalateParkedStories(client, () => 100);

    expect(changes.map((change) => change.epicId).toSorted()).toEqual(["E1", "E2"]);
    expect(await epicState("E1")).toBe("BLOCKED");
    expect(await epicState("E2")).toBe("BLOCKED");
    const question = String((await latestBlock(client, "E1"))?.question.question);
    expect(question).toContain("\u505c\u9760");

    await client.execute("UPDATE stories SET state = 'CODE' WHERE id = 'S-E1-01'");
    await escalateParkedStories(client, () => 200);
    expect(await epicState("E1")).toBe("EXECUTING");
  });


  it("blocks an executing Epic whose Story waits for a person and says which Story and why", async () => {
    await epic("E1", "EXECUTING");
    await story("S-E1-01", "E1", "DELIVERED");
    await story("S-E1-02", "E1", "NEEDS_INPUT", "blocking_question");
    await story("S-E1-03", "E1", "NEEDS_INPUT", "cost_ceiling_exceeded");
    await epic("E2", "EXECUTING");
    await story("S-E2-01", "E2", "CODE");

    const changes = await escalateParkedStories(client, () => 1_000);

    expect(changes).toEqual([{ epicId: "E1", storyIds: ["S-E1-02", "S-E1-03"], kind: "blocked" }]);
    expect(await epicState("E1")).toBe("BLOCKED");
    expect(await epicState("E2")).toBe("EXECUTING");
    expect(await transitions("E1")).toEqual([expect.objectContaining({
      from: "EXECUTING",
      to: "BLOCKED",
      reason: "Story S-E1-02 stopped: blocking_question; Story S-E1-03 stopped: cost_ceiling_exceeded",
      escalation: true,
    })]);
    const block = await latestBlock(client, "E1");
    expect(block?.escalation).toBe(true);
    expect(block?.question.question).toContain("S-E1-02");
    expect(block?.question.options).toEqual([]);
    // The Epic page tells the person where to answer, not to answer here.
    const comment = (await client.execute("SELECT payload FROM notion_outbox WHERE operation = 'comment_epic_page'")).rows[0];
    expect(String(comment?.payload)).toContain("Story 页面");
    expect(String(comment?.payload)).not.toContain("拆解");
  });

  it("changes nothing when run again in the same state", async () => {
    await epic("E1", "EXECUTING");
    await story("S-E1-01", "E1", "NEEDS_INPUT", "retry_limit_exceeded");
    await escalateParkedStories(client, () => 1_000);

    expect(await escalateParkedStories(client, () => 2_000)).toEqual([]);
    expect(await transitions("E1")).toHaveLength(1);
    expect((await client.execute("SELECT COUNT(*) AS n FROM notion_outbox")).rows[0]?.n).toBe(1);
    // The recurring surface pass does not duplicate the comment either.
    await surfaceBlockedEpics(client, () => 3_000);
    expect((await client.execute("SELECT COUNT(*) AS n FROM notion_outbox")).rows[0]?.n).toBe(1);
  });

  it("resumes the Epic by itself once no Story waits any more", async () => {
    await epic("E1", "EXECUTING");
    await story("S-E1-01", "E1", "NEEDS_INPUT", "blocking_question");
    await escalateParkedStories(client, () => 1_000);

    await client.execute("UPDATE stories SET state = 'CODE', stop_reason = NULL WHERE id = 'S-E1-01'");
    const changes = await escalateParkedStories(client, () => 2_000);

    expect(changes).toEqual([{ epicId: "E1", storyIds: ["S-E1-01"], kind: "unblocked" }]);
    expect(await epicState("E1")).toBe("EXECUTING");
    expect(await transitions("E1")).toHaveLength(2);
    expect((await transitions("E1"))[1]).toMatchObject({ from: "BLOCKED", to: "EXECUTING", escalation: true });
    expect(await escalateParkedStories(client, () => 3_000)).toEqual([]);
  });

  it("leaves an Epic blocked by a decomposition question alone even with no parked Story", async () => {
    await epic("E1", "BLOCKED");
    await client.execute({
      sql: "INSERT INTO event_log (run_id, seq, type, ts, data) VALUES ('epic:E1', 0, 'epic.transition', 1, ?)",
      args: [JSON.stringify({ from: "DECOMPOSE", to: "BLOCKED", reason: "blocking question: which customers?" })],
    });

    expect(await escalateParkedStories(client, () => 1_000)).toEqual([]);
    expect(await epicState("E1")).toBe("BLOCKED");
  });
});

describe("answerBlocker on an escalated Epic", () => {
  it("does not accept a comment on the Epic page as an answer that would re-decompose", async () => {
    await epic("E1", "EXECUTING");
    await story("S-E1-01", "E1", "DELIVERED");
    await story("S-E1-02", "E1", "NEEDS_INPUT", "blocking_question");
    await escalateParkedStories(client, () => 1_000);

    expect(await answerBlocker(client, "E1", "comment-1", "just keep going", () => 2_000)).toBe(false);
    expect(await epicState("E1")).toBe("BLOCKED");
    expect((await client.execute("SELECT COUNT(*) AS n FROM epic_approval_events")).rows[0]?.n).toBe(0);
  });
});

describe("an Epic head that is failing on its own", () => {
  it("blocks the Epic and says whose problem it is not", async () => {
    await epic("E1", "EXECUTING");
    await story("S-E1-01", "E1", "MERGE");
    await headFailing("E1", "S-E1-01");

    const changes = await escalateParkedStories(client, () => 100);

    expect(changes).toEqual([{ epicId: "E1", storyIds: [], kind: "blocked" }]);
    expect(await epicState("E1")).toBe("BLOCKED");
    const [transition] = await transitions("E1");
    expect(String(transition?.reason)).toContain("catalog-snapshot");
    const question = String((transition!.question as { question: string }).question);
    expect(question).toContain("npm test");
    expect(question).toContain("S-E1-01");
    // The Story is not asked about, because there is nothing to ask: it is
    // finished and the branch under it is not.
    expect(await epicState("E1")).toBe("BLOCKED");
  });

  it("keeps the Epic blocked until the head is green, then lets it continue", async () => {
    await epic("E1", "EXECUTING");
    await story("S-E1-01", "E1", "MERGE");
    await headFailing("E1", "S-E1-01");
    await escalateParkedStories(client, () => 100);

    expect(await escalateParkedStories(client, () => 110)).toEqual([]);
    expect(await epicState("E1")).toBe("BLOCKED");

    await headRecovered("E1", 120);
    expect(await escalateParkedStories(client, () => 130))
      .toEqual([{ epicId: "E1", storyIds: [], kind: "unblocked" }]);
    expect(await epicState("E1")).toBe("EXECUTING");
  });

  it("will not unblock an Epic whose head is green but whose Story still waits for a person", async () => {
    await epic("E1", "EXECUTING");
    await story("S-E1-01", "E1", "MERGE");
    await story("S-E1-02", "E1", "NEEDS_INPUT", "blocking_question");
    await headFailing("E1", "S-E1-01");
    await escalateParkedStories(client, () => 100);
    await headRecovered("E1", 120);

    expect(await escalateParkedStories(client, () => 130)).toEqual([]);
    expect(await epicState("E1")).toBe("BLOCKED");
  });

  it("refuses to let a comment answer a head failure into a redecomposition", async () => {
    await epic("E1", "EXECUTING");
    await story("S-E1-01", "E1", "MERGE");
    await headFailing("E1", "S-E1-01");
    await escalateParkedStories(client, () => 100);

    const block = await latestBlock(client, "E1");
    expect(block?.escalation).toBe(true);
    // An escalation is not a question anybody may answer: the head failure is
    // fixed on the branch, not by redecomposing the Epic.
    await expect(answerBlocker(client, "E1", "comment-1", "把它拆小一点", () => 140)).resolves.toBe(false);
    expect(await epicState("E1")).toBe("BLOCKED");
  });
});
