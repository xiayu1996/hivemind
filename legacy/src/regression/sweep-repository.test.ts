import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, expect, describe, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { sweepRepository } from "./sweep-repository.js";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  await client.batch([
    { sql: "INSERT INTO epics (id, notion_page_id, title, state, repo, created_at, updated_at) VALUES ('M2', 'p-m2', 'Delivery', 'EXECUTING', 'acme/widget', 1, 1)" },
    { sql: "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, repo, created_at, updated_at) VALUES ('S-M2-01', 'M2', 's-1', 'One', 'r', 'DELIVERED', 'acme/widget', 1, 1)" },
    { sql: "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, repo, created_at, updated_at) VALUES ('S-M3-01', null, 's-2', 'Two', 'r', 'DELIVERED', 'acme/other', 1, 1)" },
    { sql: "INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at) VALUES ('S-M2-01-a', 'S-M2-01', 'M2', 'epic', 1, 1)" },
    { sql: "INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at) VALUES ('S-M3-01-a', 'S-M3-01', null, 'main', 1, 1)" },
  ], "write");
});

afterEach(() => client.close());

describe("which repository a sweep is sweeping", () => {
  it("takes it from the Epic when the sweep names one", async () => {
    await expect(sweepRepository(client, { epicId: "M2", scenarioIds: [] })).resolves.toBe("acme/widget");
  });

  it("takes it from the scenarios' own Stories for a main-pool sweep", async () => {
    await expect(sweepRepository(client, { scenarioIds: ["S-M3-01-a"] })).resolves.toBe("acme/other");
  });

  it("refuses a batch spanning two repositories rather than picking one", async () => {
    // One sweep is one worktree at one revision, so the second repository's
    // scenarios would be judged against the first repository's code.
    await expect(sweepRepository(client, { scenarioIds: ["S-M2-01-a", "S-M3-01-a"] }))
      .rejects.toThrow("acme/other, acme/widget");
  });

  it("refuses an Epic that names no repository", async () => {
    await client.execute("UPDATE epics SET repo = NULL WHERE id = 'M2'");
    await expect(sweepRepository(client, { epicId: "M2", scenarioIds: [] })).rejects.toThrow("names no repository");
  });
});
