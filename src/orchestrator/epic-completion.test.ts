import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { EpicCompletion } from "./epic-completion.js";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

afterEach(() => client.close());

async function epicAwaitingReview(id: string, options: { requirementId?: string; shadow?: string } = {}): Promise<void> {
  if (options.requirementId) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
            VALUES (?, ?, 'Board', 'EXECUTING', 'ten sentences', 1, 1)`,
      args: [options.requirementId, `page-${options.requirementId}`],
    });
  }
  await client.execute({
    sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, mr_url, notion_status_shadow, created_at, updated_at)
          VALUES (?, ?, ?, 'EPIC_ACCEPT', ?, ?, ?, 1, 1)`,
    args: [id, `page-${id}`, `${id} Board`, options.requirementId ?? null, `https://example.test/pull/${id}`,
      options.shadow ?? null],
  });
}

async function poolOf(scenarioId: string): Promise<string> {
  return String((await client.execute({
    sql: "SELECT pool FROM scenario_registry WHERE scenario_id = ?", args: [scenarioId],
  })).rows[0]?.pool);
}

async function stateOf(id: string): Promise<string> {
  return String((await client.execute({ sql: "SELECT state FROM epics WHERE id = ?", args: [id] })).rows[0]?.state);
}

async function announcedStatuses(id: string): Promise<string[]> {
  return (await client.execute({
    sql: "SELECT payload FROM notion_outbox WHERE card_id = ? AND operation = 'sync_epic_status' ORDER BY id",
    args: [id],
  })).rows.map((row) => (JSON.parse(String(row.payload)) as { status: string }).status);
}

describe("EpicCompletion", () => {
  it("finishes a requirement's Epic once its review request has landed", async () => {
    await epicAwaitingReview("E1", { requirementId: "R-1" });
    const completion = new EpicCompletion(client, { state: async () => "merged" }, () => 2_000);

    await expect(completion.tick()).resolves.toEqual([{ epicId: "E1", kind: "done" }]);
    expect(await stateOf("E1")).toBe("DONE");
    expect(await announcedStatuses("E1")).toEqual(["已完成"]);
    // A finished Epic is not looked at again.
    await expect(completion.tick()).resolves.toEqual([]);
  });

  it("moves the Epic's scenarios into the main pool when the merge is read, and not before", async () => {
    await epicAwaitingReview("E1", { requirementId: "R-1" });
    await client.batch([
      "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-E1-01', 'E1', 's-1', 'One', 'r', 'DELIVERED', 1, 1)",
      "INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at) VALUES ('S-E1-01-a', 'S-E1-01', 'E1', 'epic', 1, 1)",
    ], "write");

    const open = new EpicCompletion(client, { state: async () => "open" });
    await open.tick();
    expect(await poolOf("S-E1-01-a")).toBe("epic");

    const merged = new EpicCompletion(client, { state: async () => "merged" }, () => 2_000);
    await merged.tick();
    expect(await poolOf("S-E1-01-a")).toBe("main");
  });

  it("waits while the review request is still open", async () => {
    await epicAwaitingReview("E1", { requirementId: "R-1" });
    const completion = new EpicCompletion(client, { state: async () => "open" });

    await expect(completion.tick()).resolves.toEqual([{ epicId: "E1", kind: "awaiting_merge" }]);
    expect(await stateOf("E1")).toBe("EPIC_ACCEPT");
    expect(await announcedStatuses("E1")).toEqual([]);
  });

  it("asks a standalone Epic's owner to accept it on the board, even after the merge", async () => {
    await epicAwaitingReview("E1");
    const completion = new EpicCompletion(client, { state: async () => "merged" });

    await expect(completion.tick()).resolves.toEqual([{ epicId: "E1", kind: "awaiting_acceptance" }]);
    expect(await stateOf("E1")).toBe("EPIC_ACCEPT");

    await client.execute({ sql: "UPDATE epics SET notion_status_shadow = '已完成' WHERE id = ?", args: ["E1"] });
    await expect(completion.tick()).resolves.toEqual([{ epicId: "E1", kind: "done" }]);
    expect(await stateOf("E1")).toBe("DONE");
  });

  it("reports a platform it cannot read instead of guessing, and moves on to the next Epic", async () => {
    await epicAwaitingReview("E1", { requirementId: "R-1" });
    await epicAwaitingReview("E2", { requirementId: "R-1" });
    const completion = new EpicCompletion(client, {
      state: async (url) => {
        if (url.endsWith("E1")) throw new Error("gh: HTTP 502");
        return "merged";
      },
    });

    await expect(completion.tick()).resolves.toEqual([
      { epicId: "E1", kind: "unreadable", reason: "gh: HTTP 502" },
      { epicId: "E2", kind: "done" },
    ]);
    expect(await stateOf("E1")).toBe("EPIC_ACCEPT");
  });

  it("sends an Epic whose review request was closed without merging back to execution for a fresh one", async () => {
    await epicAwaitingReview("E1", { requirementId: "R-1" });
    const completion = new EpicCompletion(client, { state: async () => "closed" }, () => 5_000);

    await expect(completion.tick()).resolves.toEqual([
      { epicId: "E1", kind: "review_closed", reason: "review request https://example.test/pull/E1 was closed without merging" },
    ]);
    const epic = (await client.execute("SELECT state, mr_url FROM epics WHERE id = 'E1'")).rows[0];
    expect(epic).toMatchObject({ state: "EXECUTING", mr_url: null });
    const events = (await client.execute("SELECT type, data FROM event_log WHERE type = 'epic.review_closed'")).rows;
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0]?.data))).toMatchObject({ epicId: "E1", mrUrl: "https://example.test/pull/E1" });
    // Without an mr_url the Epic is no longer this loop's concern.
    await expect(completion.tick()).resolves.toEqual([]);
  });
});
