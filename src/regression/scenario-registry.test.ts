import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { ScenarioRegistry } from "./scenario-registry.js";

describe("ScenarioRegistry", () => {
  let client: ReturnType<typeof createClient>;
  let time: number;
  let registry: ScenarioRegistry;

  async function seedStory(id: string, state: string, scenarios: string[], epicId: string | null = "M2"): Promise<void> {
    await client.execute({
      sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'requirement', ?, 1, 1)`,
      args: [id, epicId, `page-${id}`, id, state],
    });
    if (scenarios.length > 0) {
      await client.batch(scenarios.map((scenarioId, index) => ({
        sql: "INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES (?, ?, ?, 't', 'pending')",
        args: [scenarioId, id, index + 1],
      })), "write");
    }
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2','p','M2','EXECUTING',1,1)",
    );
    time = 1_000;
    registry = new ScenarioRegistry(client, () => time);
  });

  afterEach(() => client.close());

  it("registers every scenario a Story declares, into its Epic's pool", async () => {
    await seedStory("S-M2-01", "CODE", ["S-M2-01-a", "S-M2-01-b"]);

    await expect(registry.registerStory("S-M2-01")).resolves.toBe(2);
    await expect(registry.pool("epic")).resolves.toMatchObject([
      { scenarioId: "S-M2-01-a", storyId: "S-M2-01", epicId: "M2", lastVerifiedAt: null },
      { scenarioId: "S-M2-01-b", storyId: "S-M2-01" },
    ]);
  });

  it("does not forget when a scenario was last verified if the Story registers again", async () => {
    await seedStory("S-M2-01", "CODE", ["S-M2-01-a"]);
    await registry.registerStory("S-M2-01");
    await registry.markVerified(["S-M2-01-a"], 5_000);

    time = 9_000;
    await registry.registerStory("S-M2-01");

    await expect(registry.pool("epic")).resolves.toMatchObject([{ lastVerifiedAt: 5_000 }]);
  });

  it("moves a delivered Story's scenarios into the main pool", async () => {
    await seedStory("S-M2-01", "CODE", ["S-M2-01-a"]);
    await registry.registerStory("S-M2-01");

    await registry.promoteToMain("S-M2-01");

    await expect(registry.pool("epic")).resolves.toEqual([]);
    await expect(registry.pool("main")).resolves.toMatchObject([{ scenarioId: "S-M2-01-a", pool: "main" }]);
  });

  it("orders a pool least-recently-verified first, with the never-verified ahead of everything", async () => {
    await seedStory("S-M2-01", "CODE", ["S-M2-01-a", "S-M2-01-b", "S-M2-01-c"]);
    await registry.registerStory("S-M2-01");
    await registry.markVerified(["S-M2-01-b"], 8_000);
    await registry.markVerified(["S-M2-01-c"], 3_000);

    await expect(registry.pool("epic")).resolves.toMatchObject([
      { scenarioId: "S-M2-01-a", lastVerifiedAt: null },
      { scenarioId: "S-M2-01-c", lastVerifiedAt: 3_000 },
      { scenarioId: "S-M2-01-b", lastVerifiedAt: 8_000 },
    ]);
  });

  it("collects every scenario an Epic owns, whichever pool they sit in", async () => {
    await seedStory("S-M2-01", "DELIVERED", ["S-M2-01-a"]);
    await seedStory("S-M2-02", "CODE", ["S-M2-02-a"]);
    await registry.registerStory("S-M2-01");
    await registry.registerStory("S-M2-02");

    await expect(registry.forEpic("M2")).resolves.toMatchObject([
      { scenarioId: "S-M2-01-a", pool: "main" },
      { scenarioId: "S-M2-02-a", pool: "epic" },
    ]);
  });

  it("registers a Story with no Epic straight into the pool it will live in", async () => {
    await seedStory("S-VAL-01", "DELIVERED", ["S-VAL-01-a"], null);

    await registry.registerStory("S-VAL-01");

    await expect(registry.pool("main")).resolves.toMatchObject([{ scenarioId: "S-VAL-01-a", epicId: null }]);
  });

  it("refuses to register a Story that does not exist", async () => {
    await expect(registry.registerStory("S-M2-99")).rejects.toThrow(/does not exist/);
  });
});
