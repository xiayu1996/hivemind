import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { attributeCard, attributionSequence } from "./attribution-runner.js";
import { RegressionStore } from "./store.js";

describe("attribution over a real integration sequence", () => {
  let client: ReturnType<typeof createClient>;
  let store: RegressionStore;

  async function integrate(storyId: string, order: number, base: string, revision: string): Promise<void> {
    await client.batch([
      {
        sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at)
              VALUES (?, 'M2', ?, ?, 'requirement', 'DELIVERED', 1, 1)`,
        args: [storyId, `page-${storyId}`, storyId],
      },
      {
        sql: `INSERT INTO execution_dispatches (story_id, epic_id, state, created_at, integrated_at)
              VALUES (?, 'M2', 'integrated', 1, ?)`,
        args: [storyId, order],
      },
      {
        sql: `INSERT INTO actual_footprint_captures
                (story_id, integration_branch, base_revision, story_revision, actual_footprint, state, created_at, applied_at)
              VALUES (?, 'epic/M2', ?, ?, '[]', 'applied', 1, 1)`,
        args: [storyId, base, revision],
      },
    ], "write");
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    store = new RegressionStore(client, () => 100);
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2','p','M2','EXECUTING',1,1)",
    );
    await integrate("S-M2-01", 10, "rev-base", "rev-1");
    await integrate("S-M2-02", 20, "rev-1", "rev-2");
    await integrate("S-M2-03", 30, "rev-2", "rev-3");
    await client.execute({
      sql: "INSERT INTO regression_cards (scenario_id, failure_signature, created_at) VALUES ('S-M2-01-a', 'sig', 1)",
    });
  });

  afterEach(() => client.close());

  it("reads the order Stories landed and the revision each one produced", async () => {
    await expect(attributionSequence(client, "M2")).resolves.toEqual({
      base: "rev-base",
      steps: [
        { storyId: "S-M2-01", revision: "rev-1" },
        { storyId: "S-M2-02", revision: "rev-2" },
        { storyId: "S-M2-03", revision: "rev-3" },
      ],
    });
  });

  it("reopens the Story that introduced the break, ahead of everything else", async () => {
    const failing = new Set(["rev-2", "rev-3"]);
    const probe = vi.fn(async (revision: string) => failing.has(revision));

    const attribution = await attributeCard(
      client,
      store,
      { scenarioId: "S-M2-01-a", failureSignature: "sig" },
      await attributionSequence(client, "M2"),
      probe,
      () => 500,
    );

    expect(attribution).toMatchObject({ kind: "introduced", item: "S-M2-02" });
    await expect(store.openCards()).resolves.toMatchObject([{ attributedStory: "S-M2-02" }]);
    const story = (await client.execute("SELECT state, priority FROM stories WHERE id = 'S-M2-02'")).rows[0];
    expect(story).toMatchObject({ state: "REGRESSION_FIX", priority: 0 });
    expect((await client.execute("SELECT type FROM event_log WHERE card_id = 'S-M2-02'")).rows)
      .toMatchObject([{ type: "regression.attributed" }]);
  });

  it("blames nobody when the failure predates the sequence", async () => {
    const attribution = await attributeCard(
      client,
      store,
      { scenarioId: "S-M2-01-a", failureSignature: "sig" },
      await attributionSequence(client, "M2"),
      async () => true,
      () => 500,
    );

    expect(attribution).toMatchObject({ kind: "pre_existing" });
    await expect(store.openCards()).resolves.toMatchObject([{ attributedStory: null }]);
    expect((await client.execute("SELECT state FROM stories WHERE id = 'S-M2-03'")).rows[0]?.state)
      .toBe("DELIVERED");
  });

  it("does not reopen anything for a failure it cannot reproduce", async () => {
    const attribution = await attributeCard(
      client,
      store,
      { scenarioId: "S-M2-01-a", failureSignature: "sig" },
      await attributionSequence(client, "M2"),
      async () => false,
      () => 500,
    );

    expect(attribution).toMatchObject({ kind: "not_reproduced" });
    await expect(store.openCards()).resolves.toMatchObject([{ attributedStory: null }]);
  });

  it("leaves a Story that is already back in the pipeline where it is", async () => {
    await client.execute("UPDATE stories SET state = 'CODE' WHERE id = 'S-M2-02'");
    const failing = new Set(["rev-2", "rev-3"]);

    const attribution = await attributeCard(
      client,
      store,
      { scenarioId: "S-M2-01-a", failureSignature: "sig" },
      await attributionSequence(client, "M2"),
      async (revision: string) => failing.has(revision),
      () => 500,
    );

    expect(attribution).toMatchObject({ kind: "introduced", item: "S-M2-02" });
    expect((await client.execute("SELECT state FROM stories WHERE id = 'S-M2-02'")).rows[0]?.state).toBe("CODE");
    await expect(store.openCards()).resolves.toMatchObject([{ attributedStory: "S-M2-02" }]);
  });
});
