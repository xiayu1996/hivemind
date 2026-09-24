import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { FLOW_INVARIANTS, checkInvariants } from "./invariants.js";

let client: Client;

async function story(id: string, state: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at)
          VALUES (?, ?, 'Story', 'Requirement', ?, 1, 1)`,
    args: [id, `page-${id}`, state],
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

describe("flow invariants", () => {
  it("reports a card that reached CODE without a frozen contract", async () => {
    await story("S-1", "CODE");
    const findings = await checkInvariants(client);
    expect(findings.map((finding) => finding.invariant)).toContain("code-has-a-frozen-contract");
    expect(findings.map((finding) => finding.invariant)).toContain("work-has-a-frozen-contract");
  });

  it("says nothing about a card that has what it should", async () => {
    await story("S-1", "CODE");
    await client.batch([
      {
        sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
              VALUES ('shape-1', 'S-1', 'SHAPE', 1, ?, 'completed', 1, 2)`,
        args: ["a".repeat(64)],
      },
      {
        sql: `INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at)
              VALUES ('shape-1', 'S-1', 'SHAPE', 1, 'dod', 'contract', 2)`,
        args: [],
      },
      {
        sql: `INSERT INTO story_test_contracts (card_id, attempt, mode, contract_yaml, specify_base_commit,
                                                specify_commit, specify_tree_sha, created_at, frozen_at)
              VALUES ('S-1', 1, 'full', 'contract', 'base', 'commit', 'tree', 2, 3)`,
        args: [],
      },
    ], "write");
    expect(await checkInvariants(client)).toEqual([]);
  });

  it("reports a rework that was applied but invalidated nothing", async () => {
    await story("S-1", "CODE");
    await client.batch([
      {
        sql: `INSERT INTO ingested_comments (comment_id, page_id, body, created_time, ingested_at)
              VALUES ('c-1', 'page-S-1', 'this approach is wrong', 10, 10)`,
        args: [],
      },
      {
        sql: `INSERT INTO human_feedback (card_id, comment_id, channel, body, created_at, applied_at)
              VALUES ('S-1', 'c-1', 'rework', 'this approach is wrong', 10, 11)`,
        args: [],
      },
    ], "write");
    const findings = await checkInvariants(client, FLOW_INVARIANTS.filter((one) => one.name === "rework-invalidates-something"));
    expect(findings).toMatchObject([{ invariant: "rework-invalidates-something", cardId: "S-1" }]);
  });

  it("turns a check that cannot run into a finding rather than silence", async () => {
    const findings = await checkInvariants(client, [{
      name: "broken",
      statement: "never holds",
      check: async () => { throw new Error("no such table"); },
    }]);
    expect(findings).toMatchObject([{ invariant: "broken", detail: expect.stringContaining("no such table") }]);
  });
});
