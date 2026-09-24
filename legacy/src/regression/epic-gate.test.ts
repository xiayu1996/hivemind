import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { epicRegressionClean, epicsAwaitingDelivery, scenariosAwaitingDelivery, unprovenScenarios } from "./epic-gate.js";

let client: Client;

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OLDER = "0000000000000000000000000000000000000001";

/** Both of the Epic's scenarios passing at the revision under review. */
async function sweptClean(revision = HEAD): Promise<void> {
  await client.execute({
    sql: "INSERT INTO regression_runs (scenario_id, pool, revision, outcome, ts) VALUES ('S-M2-01-a', 'epic', ?, 'passed', 2)",
    args: [revision],
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  await client.batch([
    { sql: "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2', 'p-m2', 'Delivery', 'EXECUTING', 1, 1)" },
    { sql: "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M3', 'p-m3', 'Other', 'EXECUTING', 1, 1)" },
    { sql: "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-M2-01', 'M2', 's-1', 'One', 'r', 'DELIVERED', 1, 1)" },
    { sql: "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-M3-01', 'M3', 's-2', 'Two', 'r', 'DELIVERED', 1, 1)" },
    { sql: "INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at) VALUES ('S-M2-01-a', 'S-M2-01', 'M2', 'epic', 1, 1)" },
    { sql: "INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at) VALUES ('S-M3-01-a', 'S-M3-01', 'M3', 'epic', 1, 1)" },
  ], "write");
});

afterEach(() => client.close());

describe("epicRegressionClean", () => {
  it("opens the review request once every scenario passed at the proposed revision", async () => {
    await sweptClean();
    await expect(epicRegressionClean(client, "M2", HEAD)).resolves.toEqual({ clean: true });
  });

  it("waits when the registry has never been swept, rather than reading silence as a pass", async () => {
    // E1ACTION on 2026-09-11: six delivered Stories, scenarios registered, no
    // regression run ever recorded. The old gate called that clean.
    const gate = await epicRegressionClean(client, "M2", HEAD);
    expect(gate.clean).toBe(false);
    expect(gate.reason).toContain("no passing run");
    expect(gate.reason).toContain("S-M2-01-a");
  });

  it("waits when the only passing run is against an earlier head", async () => {
    await sweptClean(OLDER);
    await expect(epicRegressionClean(client, "M2", HEAD)).resolves.toMatchObject({ clean: false });
  });

  it("does not accept a failing run at the proposed revision as coverage", async () => {
    await client.execute({
      sql: "INSERT INTO regression_runs (scenario_id, pool, revision, outcome, failure_signature, ts) VALUES ('S-M2-01-a', 'epic', ?, 'failed', 'sig', 2)",
      args: [HEAD],
    });
    await expect(epicRegressionClean(client, "M2", HEAD)).resolves.toMatchObject({ clean: false });
  });

  it("holds the Epic while one of its scenarios has an open card, naming the scenario", async () => {
    await sweptClean();
    await client.execute("INSERT INTO regression_cards (scenario_id, failure_signature, created_at) VALUES ('S-M2-01-a', 'sig', 1)");
    await expect(epicRegressionClean(client, "M2", HEAD)).resolves.toEqual({
      clean: false,
      reason: "Epic M2 has 1 open regression card(s) on S-M2-01-a",
    });
  });

  it("ignores cards on another Epic's scenarios and cards that were resolved", async () => {
    await sweptClean();
    await client.execute("INSERT INTO regression_cards (scenario_id, failure_signature, created_at) VALUES ('S-M3-01-a', 'sig', 1)");
    await client.execute("INSERT INTO regression_cards (scenario_id, failure_signature, created_at) VALUES ('S-M2-01-a', 'sig', 1)");
    await client.execute("UPDATE regression_cards SET resolved_at = 9 WHERE scenario_id = 'S-M2-01-a'");
    await expect(epicRegressionClean(client, "M2", HEAD)).resolves.toEqual({ clean: true });
    await expect(epicRegressionClean(client, "M3", HEAD)).resolves.toMatchObject({ clean: false });
  });

  it("attribution alone does not clear the gate", async () => {
    await sweptClean();
    await client.execute("INSERT INTO regression_cards (scenario_id, failure_signature, attributed_story, created_at) VALUES ('S-M2-01-a', 'sig', 'S-M2-01', 1)");
    await expect(epicRegressionClean(client, "M2", HEAD)).resolves.toMatchObject({ clean: false });
  });

  it("waits on an Epic that registered no scenarios at all", async () => {
    await client.execute("DELETE FROM scenario_registry WHERE epic_id = 'M2'");
    await expect(epicRegressionClean(client, "M2", HEAD)).resolves.toMatchObject({ clean: false });
  });

  it("refuses to judge without a revision", async () => {
    await expect(epicRegressionClean(client, "M2", "  ")).rejects.toThrow("needs the revision");
  });
});

describe("what the review request is waiting on", () => {
  it("names a scenario that passed on an earlier head but not on this one", async () => {
    await sweptClean(OLDER);
    // The looser question -- has it ever passed -- answers "nothing to sweep"
    // here, and the Epic then waits for an idle host it may never get.
    await expect(unprovenScenarios(client, "M2", HEAD)).resolves.toEqual(["S-M2-01-a"]);
    await sweptClean(HEAD);
    await expect(unprovenScenarios(client, "M2", HEAD)).resolves.toEqual([]);
  });

  it("keeps sweeping a scenario that passes at the head but still carries a card", async () => {
    await sweptClean(HEAD);
    await client.execute("INSERT INTO regression_cards (scenario_id, failure_signature, created_at) VALUES ('S-M2-01-a', 'sig', 1)");

    // Proven, so the narrow question reports nothing to run -- and the card
    // that holds the gate closes on evidence only a sweep can produce.
    await expect(unprovenScenarios(client, "M2", HEAD)).resolves.toEqual([]);
    await expect(scenariosAwaitingDelivery(client, "M2", HEAD)).resolves.toEqual(["S-M2-01-a"]);

    await client.execute("UPDATE regression_cards SET resolved_at = 9");
    await expect(scenariosAwaitingDelivery(client, "M2", HEAD)).resolves.toEqual([]);
  });

  it("offers only the Epics whose remaining obstacle is evidence", async () => {
    await client.batch([
      { sql: "UPDATE epics SET repo = 'acme/widget'" },
      { sql: "INSERT INTO epics (id, notion_page_id, title, state, repo, created_at, updated_at) VALUES ('M4', 'p-m4', 'Empty', 'EXECUTING', 'acme/widget', 1, 1)" },
      { sql: "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-M3-02', 'M3', 's-3', 'Three', 'r', 'CODE', 1, 1)" },
    ], "write");

    // M2: every Story delivered. M3: one still running. M4: no Stories at all,
    // which is a decomposition question rather than a sweep.
    await expect(epicsAwaitingDelivery(client, "acme/widget")).resolves.toEqual(["M2"]);
    await expect(epicsAwaitingDelivery(client, "other/repo")).resolves.toEqual([]);

    await client.execute("UPDATE epics SET mr_url = 'https://example.invalid/1' WHERE id = 'M2'");
    await expect(epicsAwaitingDelivery(client, "acme/widget")).resolves.toEqual([]);
  });
});
