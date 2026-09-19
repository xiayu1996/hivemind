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

  async function register(scenarioId: string, storyId: string): Promise<void> {
    await client.execute({
      sql: `INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at)
            VALUES (?, ?, 'M2', 'epic', 1, 1)`,
      args: [scenarioId, storyId],
    });
  }

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

  // `git checkout --detach ''` is a fatal pathspec error that takes down the
  // sweep for the whole Epic, so a sequence with a hole in it is no sequence.
  it("reports no sequence when a captured revision is missing", async () => {
    await integrate("S-M2-04", 4, "rev-base", "");
    await expect(attributionSequence(client, "M2")).resolves.toEqual({ base: "", steps: [] });
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
    // Reopened at the narrow SPECIFY, with the phase naming where it leads: the
    // reproduction test is written before the fix is allowed to start.
    const story = (await client.execute("SELECT state, phase, priority FROM stories WHERE id = 'S-M2-02'")).rows[0];
    expect(story).toMatchObject({ state: "SPECIFY", phase: "REGRESSION_FIX", priority: 0 });
    expect((await client.execute("SELECT type FROM event_log WHERE card_id = 'S-M2-02'")).rows)
      .toMatchObject([{ type: "regression.attributed" }]);
  });

  it("reopens the Story that registered the scenario when nobody introduced the break", async () => {
    // Nobody in the sequence broke it, so the bisect names nobody -- and the
    // card used to stay open with no actor able to close it, holding the Epic
    // at its review gate while every sweep paid to fail again.
    await register("S-M2-01-a", "S-M2-01");

    const attribution = await attributeCard(
      client,
      store,
      { scenarioId: "S-M2-01-a", failureSignature: "sig" },
      await attributionSequence(client, "M2"),
      async () => true,
      () => 500,
    );

    expect(attribution).toMatchObject({ kind: "pre_existing" });
    await expect(store.openCards()).resolves.toMatchObject([{ attributedStory: "S-M2-01" }]);
    expect((await client.execute("SELECT state, phase FROM stories WHERE id = 'S-M2-01'")).rows[0])
      .toMatchObject({ state: "SPECIFY", phase: "REGRESSION_FIX" });
    // The log says which of the two ways the owner was found, because only one
    // of them survived a bisect.
    const event = (await client.execute("SELECT data FROM event_log WHERE card_id = 'S-M2-01'")).rows[0];
    expect(JSON.parse(String(event?.data)) as { origin: string }).toMatchObject({ origin: "never_proven" });
  });

  it("blames nobody for a scenario no Story registered", async () => {
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

  it("probes nothing on an Epic head nothing has landed on", async () => {
    // The empty base is what "no Story has integrated yet" looks like. Handed
    // to the probe it became `git checkout --detach ''`, a fatal pathspec
    // error that took the whole Epic's sweep down with it. The owner is still
    // known without probing, because registration named it.
    await register("S-M2-01-a", "S-M2-01");
    let probes = 0;
    const attribution = await attributeCard(
      client,
      store,
      { scenarioId: "S-M2-01-a", failureSignature: "sig" },
      { base: "", steps: [] },
      async () => { probes += 1; return true; },
      () => 500,
    );

    expect(attribution).toMatchObject({ kind: "pre_existing" });
    expect(probes).toBe(0);
    await expect(store.openCards()).resolves.toMatchObject([{ attributedStory: "S-M2-01" }]);
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
