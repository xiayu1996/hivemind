import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { RegressionStore, regressionPolicy } from "./store.js";
import type { RegressionPolicy } from "./verdict.js";

const policy: RegressionPolicy = { windowSize: 10, failureRateThreshold: 0.5, minFailures: 3 };

describe("RegressionStore", () => {
  let client: ReturnType<typeof createClient>;
  let store: RegressionStore;
  let time: number;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    time = 1_000;
    store = new RegressionStore(client, () => time++);
  });

  afterEach(() => client.close());

  async function fail(output = "AssertionError: expected 3 to be 4 at src/cart.test.ts:12"): Promise<ReturnType<RegressionStore["record"]>> {
    return store.record({ scenarioId: "S-M2-01-a", pool: "main", revision: "abc123", outcome: "failed", output }, policy);
  }

  it("keeps a lone failure as a suspect and raises no card", async () => {
    await expect(fail()).resolves.toMatchObject({ judgement: { kind: "suspect" }, cardRaised: false });
    await expect(store.openCards()).resolves.toEqual([]);
  });

  it("raises one card for a break that reproduces, and only one", async () => {
    await fail();
    await fail();
    const third = await fail();
    expect(third).toMatchObject({ judgement: { kind: "raise" }, cardRaised: true });

    const fourth = await fail();
    expect(fourth).toMatchObject({ judgement: { kind: "raise" }, cardRaised: false });
    await expect(store.openCards()).resolves.toHaveLength(1);
  });

  it("closes an open card once the scenario stops failing, with no owner asked for", async () => {
    await fail();
    await fail();
    await fail();
    await expect(store.openCards()).resolves.toHaveLength(1);

    // The card was never attributed, so no Story could ever close it.
    for (let i = 0; i < policy.windowSize; i += 1) {
      await store.record({ scenarioId: "S-M2-01-a", pool: "main", revision: "def456", outcome: "passed" }, policy);
    }
    await expect(store.openCards()).resolves.toEqual([]);
  });

  it("keeps the card open while the scenario is still failing some of the time", async () => {
    await fail();
    await fail();
    await fail();
    await store.record({ scenarioId: "S-M2-01-a", pool: "main", revision: "def456", outcome: "passed" }, policy);
    await store.record({ scenarioId: "S-M2-01-a", pool: "main", revision: "def456", outcome: "passed" }, policy);
    await expect(store.openCards()).resolves.toHaveLength(1);
  });

  it("does not raise a card for a scenario that fails about a third of the time", async () => {
    for (const outcome of ["failed", "passed", "passed", "failed", "passed", "passed", "passed", "failed", "passed", "passed"] as const) {
      await store.record({
        scenarioId: "S-M2-01-a",
        pool: "main",
        revision: "abc123",
        outcome,
        ...(outcome === "failed" ? { output: "flaky timeout waiting for element" } : {}),
      }, policy);
    }
    await expect(store.openCards()).resolves.toEqual([]);
  });

  it("keeps one open card per scenario however differently it fails", async () => {
    // A screen's failure is a sentence somebody wrote about it, so a scenario
    // that is simply broken produces a new signature every sweep. A card per
    // signature meant another copy of the same work item every round, in the
    // Story's fix round and in the Epic's gate message.
    for (let attempt = 0; attempt < 3; attempt++) await fail("AssertionError: expected 3 to be 4");
    for (let attempt = 0; attempt < 8; attempt++) await fail("TypeError: cart is not iterable");

    await expect(store.openCards()).resolves.toMatchObject([{ failureText: "assertionerror: expected <n> to be <n>" }]);
  });

  it("raises again for the next break once the card for the last one is closed", async () => {
    for (let attempt = 0; attempt < 3; attempt++) await fail("AssertionError: expected 3 to be 4");
    const [first] = await store.openCards();
    await store.attribute(first!.scenarioId, first!.failureSignature, "S-M2-03");
    await store.resolveCard(first!.scenarioId, first!.failureSignature, "S-M2-03");

    for (let attempt = 0; attempt < 3; attempt++) await fail("TypeError: cart is not iterable");

    await expect(store.openCards()).resolves.toMatchObject([{ failureText: "typeerror: cart is not iterable" }]);
  });

  it("records the Story a card was attributed to", async () => {
    for (let attempt = 0; attempt < 3; attempt++) await fail();
    const [card] = await store.openCards();

    await store.attribute(card!.scenarioId, card!.failureSignature, "S-M2-03");

    await expect(store.openCards()).resolves.toMatchObject([{ attributedStory: "S-M2-03" }]);
  });

  it("offers an ownerless card up again, and stops once it has an owner", async () => {
    // A card nobody owns is reached by no other query, so a sweep that stopped
    // looking after the round that raised it left the card open forever.
    for (let attempt = 0; attempt < 3; attempt++) await fail();
    const [card] = await store.openCards();

    await expect(store.unattributedCards([card!.scenarioId])).resolves.toHaveLength(1);
    await expect(store.unattributedCards(["S-M2-03-elsewhere"])).resolves.toEqual([]);
    await expect(store.unattributedCards([])).resolves.toEqual([]);

    await store.attribute(card!.scenarioId, card!.failureSignature, "S-M2-03");
    await expect(store.unattributedCards([card!.scenarioId])).resolves.toEqual([]);
  });

  it("closes a card only for the Story it was attributed to, then lets the same break raise again", async () => {
    for (let attempt = 0; attempt < 3; attempt++) await fail();
    const [card] = await store.openCards();
    await store.attribute(card!.scenarioId, card!.failureSignature, "S-M2-03");

    await expect(store.resolveCard(card!.scenarioId, card!.failureSignature, "S-M2-99")).resolves.toBe(false);
    await expect(store.openCardsForStory("S-M2-03")).resolves.toHaveLength(1);

    await expect(store.resolveCard(card!.scenarioId, card!.failureSignature, "S-M2-03", 5_000)).resolves.toBe(true);
    await expect(store.openCards()).resolves.toEqual([]);
    await expect(store.openCardsForStory("S-M2-03")).resolves.toEqual([]);
    const row = (await client.execute("SELECT resolved_at FROM regression_cards")).rows[0];
    expect(row).toMatchObject({ resolved_at: 5_000 });

    for (let attempt = 0; attempt < 3; attempt++) await fail();
    await expect(store.openCards()).resolves.toHaveLength(1);
  });

  it("scopes open cards to an Epic through the attributed Story", async () => {
    await client.execute({
      sql: "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('E-1', 'p-e1', 'Epic', 'EXECUTING', 1, 1)",
      args: [],
    });
    await client.execute({
      sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at)
            VALUES ('S-M2-03', 'E-1', 'p-s1', 'Story', 'req', 'DELIVERED', 1, 1)`,
      args: [],
    });
    for (let attempt = 0; attempt < 3; attempt++) await fail("AssertionError: expected 3 to be 4");
    for (let attempt = 0; attempt < 3; attempt++) {
      await store.record({
        scenarioId: "S-M2-01-b", pool: "main", revision: "abc123", outcome: "failed",
        output: "TypeError: cart is not iterable",
      }, policy);
    }
    const [attributed] = await store.openCards();
    await store.attribute(attributed!.scenarioId, attributed!.failureSignature, "S-M2-03");

    await expect(store.openCards("E-1")).resolves.toMatchObject([{ attributedStory: "S-M2-03" }]);
    await expect(store.openCards("E-other")).resolves.toEqual([]);
    await expect(store.openCards()).resolves.toHaveLength(2);
  });

  it("stores no signature for a passing run, which the schema enforces", async () => {
    await store.record({ scenarioId: "S-M2-01-a", pool: "epic", revision: "abc", outcome: "passed" }, policy);
    const row = (await client.execute("SELECT outcome, failure_signature FROM regression_runs")).rows[0];
    expect(row).toMatchObject({ outcome: "passed", failure_signature: null });
  });
});

describe("regressionPolicy", () => {
  it("comes from config so a noisy suite can be tuned without a release", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const config = await ConfigStore.load(client);

    await expect(regressionPolicy(config)).resolves.toEqual({
      windowSize: 10,
      failureRateThreshold: 0.5,
      minFailures: 3,
    });

    await config.set("regression.minFailures", 5, "test");
    await expect(regressionPolicy(config)).resolves.toMatchObject({ minFailures: 5 });
    client.close();
  });
});
