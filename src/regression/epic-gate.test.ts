import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { epicRegressionClean } from "./epic-gate.js";

let client: Client;

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
  it("is clean when no scenario of the Epic carries a card", async () => {
    await expect(epicRegressionClean(client, "M2")).resolves.toEqual({ clean: true });
  });

  it("holds the Epic while one of its scenarios has an open card, naming the scenario", async () => {
    await client.execute("INSERT INTO regression_cards (scenario_id, failure_signature, created_at) VALUES ('S-M2-01-a', 'sig', 1)");
    await expect(epicRegressionClean(client, "M2")).resolves.toEqual({
      clean: false,
      reason: "Epic M2 has 1 open regression card(s) on S-M2-01-a",
    });
  });

  it("ignores cards on another Epic's scenarios and cards that were resolved", async () => {
    await client.execute("INSERT INTO regression_cards (scenario_id, failure_signature, created_at) VALUES ('S-M3-01-a', 'sig', 1)");
    await client.execute("INSERT INTO regression_cards (scenario_id, failure_signature, created_at) VALUES ('S-M2-01-a', 'sig', 1)");
    await client.execute("UPDATE regression_cards SET resolved_at = 9 WHERE scenario_id = 'S-M2-01-a'");
    await expect(epicRegressionClean(client, "M2")).resolves.toEqual({ clean: true });
    await expect(epicRegressionClean(client, "M3")).resolves.toMatchObject({ clean: false });
  });

  it("attribution alone does not clear the gate", async () => {
    await client.execute("INSERT INTO regression_cards (scenario_id, failure_signature, attributed_story, created_at) VALUES ('S-M2-01-a', 'sig', 'S-M2-01', 1)");
    await expect(epicRegressionClean(client, "M2")).resolves.toMatchObject({ clean: false });
  });
});
