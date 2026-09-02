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
    const completion = new EpicCompletion(client, { isMerged: async () => true }, () => 2_000);

    await expect(completion.tick()).resolves.toEqual([{ epicId: "E1", kind: "done" }]);
    expect(await stateOf("E1")).toBe("DONE");
    expect(await announcedStatuses("E1")).toEqual(["已完成"]);
    // A finished Epic is not looked at again.
    await expect(completion.tick()).resolves.toEqual([]);
  });

  it("waits while the review request is still open", async () => {
    await epicAwaitingReview("E1", { requirementId: "R-1" });
    const completion = new EpicCompletion(client, { isMerged: async () => false });

    await expect(completion.tick()).resolves.toEqual([{ epicId: "E1", kind: "awaiting_merge" }]);
    expect(await stateOf("E1")).toBe("EPIC_ACCEPT");
    expect(await announcedStatuses("E1")).toEqual([]);
  });

  it("asks a standalone Epic's owner to accept it on the board, even after the merge", async () => {
    await epicAwaitingReview("E1");
    const completion = new EpicCompletion(client, { isMerged: async () => true });

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
      isMerged: async (url) => {
        if (url.endsWith("E1")) throw new Error("gh: HTTP 502");
        return true;
      },
    });

    await expect(completion.tick()).resolves.toEqual([
      { epicId: "E1", kind: "unreadable", reason: "gh: HTTP 502" },
      { epicId: "E2", kind: "done" },
    ]);
    expect(await stateOf("E1")).toBe("EPIC_ACCEPT");
  });
});
