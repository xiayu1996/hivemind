import { beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { migrate } from "../persistence/migrate.js";
import { reopenRejectedDecompositions } from "./decomposition-reopen.js";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

async function blockedEpic(epicId: string, reason: string, question?: unknown): Promise<void> {
  await client.execute({
    sql: `INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at)
          VALUES (?, ?, ?, 'BLOCKED', 1000, 1000)`,
    args: [epicId, `page-${epicId}`, "费用"],
  });
  await client.execute({
    sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
          VALUES (?, 0, NULL, 'DECOMPOSE', 'epic.transition', 1000, ?)`,
    args: [`epic:${epicId}`, JSON.stringify({ from: "DECOMPOSE", to: "BLOCKED", reason, ...(question ? { question } : {}) })],
  });
}

async function stateOf(epicId: string): Promise<string> {
  return String((await client.execute({ sql: "SELECT state FROM epics WHERE id = ?", args: [epicId] })).rows[0]!.state);
}

describe("reopenRejectedDecompositions", () => {
  it("retries a split its own checks refused, once the checks have changed", async () => {
    await blockedEpic("E-1", "decomposition rejected: Story E-1-S01 has an invalid Story id");

    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" })).resolves.toEqual(["E-1"]);
    expect(await stateOf("E-1")).toBe("DECOMPOSE");
  });

  it("retries once per change rather than every cycle", async () => {
    await blockedEpic("E-1", "decomposition rejected: Story E-1-S01 has an invalid Story id");
    await reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" });
    await client.execute("UPDATE epics SET state = 'BLOCKED' WHERE id = 'E-1'");

    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" })).resolves.toEqual([]);
    expect(await stateOf("E-1")).toBe("BLOCKED");
    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "rev-3" })).resolves.toEqual(["E-1"]);
  });

  it("leaves an Epic that is waiting on a person where it is", async () => {
    // Its way out is the answer, and reopening it would throw the question away.
    await blockedEpic("E-1", "blocking question: 这批 Story 面向哪个客户群？", {
      question: "这批 Story 面向哪个客户群？",
      options: [],
    });

    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" })).resolves.toEqual([]);
    expect(await stateOf("E-1")).toBe("BLOCKED");
  });

  it("counts a retry only against the refusal it answers", async () => {
    await blockedEpic("E-1", "decomposition rejected: Story E-1-S01 has an invalid Story id");
    await reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" });
    // Refused again under the same criteria, by something else: that is a new
    // block, and the version it was already tried under no longer describes it.
    await client.batch([
      { sql: "UPDATE epics SET state = 'BLOCKED' WHERE id = 'E-1'", args: [] },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES ('epic:E-1', 99, NULL, 'DECOMPOSE', 'epic.transition', 2000, ?)`,
        args: [JSON.stringify({ from: "DECOMPOSE", to: "BLOCKED", reason: "decomposition rejected: business goal line 1 contains implementation language" })],
      },
    ], "write");

    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" })).resolves.toEqual(["E-1"]);
  });

  it("reopens nothing when the running version cannot be read", async () => {
    await blockedEpic("E-1", "decomposition rejected: Story E-1-S01 has an invalid Story id");

    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "" })).resolves.toEqual([]);
    expect(await stateOf("E-1")).toBe("BLOCKED");
  });
});
