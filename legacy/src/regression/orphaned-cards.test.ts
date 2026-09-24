import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { describeOrphanedCard, readOrphanedCards } from "./orphaned-cards.js";

let client: Client;

const seedStory = async (id: string, epicId: string | null): Promise<void> => {
  if (epicId !== null) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO epics (id, notion_page_id, title, state, created_at, updated_at)
            VALUES (?, ?, ?, 'EXECUTING', 1, 1)`,
      args: [epicId, `page-${epicId}`, epicId],
    });
  }
  await client.execute({
    sql: `INSERT INTO stories (id, notion_page_id, title, requirement, epic_id, state, phase, created_at, updated_at)
          VALUES (?, ?, ?, 'R-1', ?, 'DELIVERED', 'DELIVERED', 1, 1)`,
    args: [id, `page-${id}`, id, epicId],
  });
};

let seq = 0;

const seedSpec = async (specId: string, storyId: string, layers: string | null): Promise<void> => {
  seq += 1;
  await client.execute({
    sql: `INSERT INTO story_specs (spec_id, story_id, seq, text, layers, status)
          VALUES (?, ?, ?, 'given when then', ?, 'passed')`,
    args: [specId, storyId, seq, layers],
  });
};

const register = async (specId: string, storyId: string, epicId: string | null): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at)
          VALUES (?, ?, ?, 'epic', 1, 1)`,
    args: [specId, storyId, epicId],
  });
};

const raiseCard = async (
  specId: string,
  storyId: string | null,
  signature = "sig-1",
  resolvedAt: number | null = null,
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO regression_cards (scenario_id, failure_signature, failure_text, attributed_story, created_at, resolved_at)
          VALUES (?, ?, 'the page said 找不到页面', ?, 100, ?)`,
    args: [specId, signature, storyId, resolvedAt],
  });
};

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  seq = 0;
});

describe("finding cards no sweep can close", () => {
  it("names a card whose scenario left the pool", async () => {
    await seedStory("S-MB-02", "E-MB");
    await seedSpec("S-MB-02-access", "S-MB-02", '["integration"]');
    await raiseCard("S-MB-02-access", "S-MB-02");

    const orphans = await readOrphanedCards(client);
    expect(orphans).toMatchObject([{
      scenarioId: "S-MB-02-access",
      attributedStory: "S-MB-02",
      layers: '["integration"]',
    }]);
  });

  it("leaves a card alone while its scenario is still swept", async () => {
    await seedStory("S-MB-02", "E-MB");
    await seedSpec("S-MB-02-costscope", "S-MB-02", '["e2e","ui"]');
    await register("S-MB-02-costscope", "S-MB-02", "E-MB");
    await raiseCard("S-MB-02-costscope", "S-MB-02");

    expect(await readOrphanedCards(client)).toEqual([]);
  });

  it("says nothing about a card that is already closed", async () => {
    await seedStory("S-MB-02", "E-MB");
    await seedSpec("S-MB-02-access", "S-MB-02", '["integration"]');
    await raiseCard("S-MB-02-access", "S-MB-02", "sig-1", 900);

    expect(await readOrphanedCards(client)).toEqual([]);
  });

  it("keeps an orphan nobody owns, which nothing else would mention", async () => {
    await seedStory("S-MB-02", "E-MB");
    await seedSpec("S-MB-02-access", "S-MB-02", '["integration"]');
    await raiseCard("S-MB-02-access", null);

    expect(await readOrphanedCards(client)).toMatchObject([{ attributedStory: null }]);
  });

  it("scopes to one Epic through the owning Story", async () => {
    await seedStory("S-MB-02", "E-MB");
    await seedStory("S-OV-01", "E-OV");
    await seedSpec("S-MB-02-access", "S-MB-02", '["integration"]');
    await seedSpec("S-OV-01-active", "S-OV-01", '["integration"]');
    await raiseCard("S-MB-02-access", "S-MB-02");
    await raiseCard("S-OV-01-active", "S-OV-01");

    expect((await readOrphanedCards(client, { epicId: "E-MB" })).map((card) => card.scenarioId)).toEqual(["S-MB-02-access"]);
    expect((await readOrphanedCards(client, { epicId: "E-OV" })).map((card) => card.scenarioId)).toEqual(["S-OV-01-active"]);
  });

  it("orders oldest first, so the longest-standing one is read first", async () => {
    await seedStory("S-MB-02", "E-MB");
    await seedSpec("S-MB-02-access", "S-MB-02", '["integration"]');
    await seedSpec("S-MB-02-roles", "S-MB-02", '["integration"]');
    await client.execute(`INSERT INTO regression_cards (scenario_id, failure_signature, attributed_story, created_at)
                          VALUES ('S-MB-02-roles', 'sig-late', 'S-MB-02', 500)`);
    await raiseCard("S-MB-02-access", "S-MB-02");

    expect((await readOrphanedCards(client)).map((card) => card.scenarioId))
      .toEqual(["S-MB-02-access", "S-MB-02-roles"]);
  });
});

describe("what the sentence tells a person", () => {
  it("names the owner, the new proof and the decision that is theirs", () => {
    const line = describeOrphanedCard({
      scenarioId: "S-MB-02-access",
      failureSignature: "sig-1",
      attributedStory: "S-MB-02",
      layers: '["integration"]',
      createdAt: 100,
    });
    expect(line).toContain("S-MB-02-access (S-MB-02)");
    expect(line).toContain("left the sweep pool");
    expect(line).toContain('["integration"]');
    expect(line).toContain("no sweep can close the card");
    expect(line).toContain("move the scenario back onto the screen lane");
  });

  it("does not invent a layer record the Definition of Done never had", () => {
    const line = describeOrphanedCard({
      scenarioId: "S-OLD-01-thing",
      failureSignature: "sig-1",
      attributedStory: null,
      layers: null,
      createdAt: 100,
    });
    expect(line).toContain("(no Story)");
    expect(line).toContain("records no layers");
  });
});
