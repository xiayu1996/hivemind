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

/** The Epic refused once more, as the orchestrator records it. */
async function refusedAgain(epicId: string, reason: string, seq = 99): Promise<void> {
  await client.batch([
    { sql: "UPDATE epics SET state = 'BLOCKED' WHERE id = ?", args: [epicId] },
    {
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES (?, ?, NULL, 'DECOMPOSE', 'epic.transition', 2000, ?)`,
      args: [`epic:${epicId}`, seq, JSON.stringify({ from: "DECOMPOSE", to: "BLOCKED", reason })],
    },
  ], "write");
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

  it("stops offering a version the attempt it paid for already refused", async () => {
    // The retry ran. That it broke a different rule this time says the split
    // changed, not that the criteria did, and handing it the same version again
    // hands it the attempt that just failed. R237511RC went round this loop
    // every cycle at brain-tier prices and never reached a person.
    await blockedEpic("E-1", "decomposition rejected: Story E-1-S01 has an invalid Story id");
    await reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" });
    await refusedAgain("E-1", "decomposition rejected: business goal line 1 contains implementation language");

    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" })).resolves.toEqual([]);
    expect(await stateOf("E-1")).toBe("BLOCKED");
    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "rev-3" })).resolves.toEqual(["E-1"]);
  });

  it("gives the split another attempt once a person has changed it", async () => {
    // An answer makes the next split a different one, so the version that
    // refused the old split says nothing about it.
    await blockedEpic("E-1", "decomposition rejected: Story E-1-S01 has an invalid Story id");
    await reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" });
    await refusedAgain("E-1", "decomposition rejected: Story E-1-S02 declares no footprint");
    await client.execute({
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES ('epic:E-1', 98, NULL, 'DECOMPOSE', 'epic.blocker_answered', 2500, '{}')`,
      args: [],
    });
    await refusedAgain("E-1", "decomposition rejected: Story E-1-S03 declares no footprint", 100);

    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "rev-2" })).resolves.toEqual(["E-1"]);
  });

  it("reopens nothing when the running version cannot be read", async () => {
    await blockedEpic("E-1", "decomposition rejected: Story E-1-S01 has an invalid Story id");

    await expect(reopenRejectedDecompositions({ client, criteriaVersion: "" })).resolves.toEqual([]);
    expect(await stateOf("E-1")).toBe("BLOCKED");
  });
});
