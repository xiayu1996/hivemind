import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { ScenarioRegistry } from "./scenario-registry.js";
import { RegressionStore } from "./store.js";
import { RegressionSweeper } from "./sweeper.js";
import type { RegressionPolicy } from "./verdict.js";

const policy: RegressionPolicy = { windowSize: 10, failureRateThreshold: 0.5, minFailures: 2 };

describe("RegressionSweeper", () => {
  let client: ReturnType<typeof createClient>;
  let registry: ScenarioRegistry;
  let store: RegressionStore;
  let time: number;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    time = 1_000;
    registry = new ScenarioRegistry(client, () => time);
    store = new RegressionStore(client, () => time);
    await client.batch([
      "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2','p','M2','EXECUTING',1,1)",
      `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at)
         VALUES ('S-M2-01','M2','p1','one','requirement','CODE',1,1)`,
      "INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES ('S-M2-01-a','S-M2-01',1,'t','pending')",
      "INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES ('S-M2-01-b','S-M2-01',2,'t','pending')",
    ], "write");
    await registry.registerStory("S-M2-01");
  });

  afterEach(() => client.close());

  it("marks only the scenarios that passed as verified", async () => {
    const port = { run: vi.fn(async () => ({
      revision: "rev-1",
      outcomes: [
        { scenarioId: "S-M2-01-a", outcome: "passed" as const },
        { scenarioId: "S-M2-01-b", outcome: "failed" as const, output: "AssertionError: expected 1 to be 2" },
      ],
    })) };
    time = 5_000;

    const result = await new RegressionSweeper(registry, store, port)
      .sweep({ pool: "epic", branch: "epic/M2", scenarioIds: ["S-M2-01-a", "S-M2-01-b"] }, policy);

    expect(result).toMatchObject({ verified: ["S-M2-01-a"], failed: ["S-M2-01-b"], raised: [] });
    const registered = await registry.forEpic("M2");
    expect(registered).toMatchObject([
      { scenarioId: "S-M2-01-a", lastVerifiedAt: 5_000 },
      { scenarioId: "S-M2-01-b", lastVerifiedAt: null },
    ]);
  });

  it("raises a card once the same break reproduces", async () => {
    const port = { run: vi.fn(async () => ({
      revision: "rev-1",
      outcomes: [{ scenarioId: "S-M2-01-a", outcome: "failed" as const, output: "TypeError: cart is not iterable" }],
    })) };
    const sweeper = new RegressionSweeper(registry, store, port);
    const input = { pool: "epic" as const, branch: "epic/M2", scenarioIds: ["S-M2-01-a"] };

    await expect(sweeper.sweep(input, policy)).resolves.toMatchObject({ raised: [] });
    const second = await sweeper.sweep(input, policy);

    expect(second.raised).toMatchObject([{ scenarioId: "S-M2-01-a" }]);
    await expect(store.openCards()).resolves.toHaveLength(1);
  });

  it("does nothing at all when the sweep is empty", async () => {
    const port = { run: vi.fn() };

    await expect(new RegressionSweeper(registry, store, port)
      .sweep({ pool: "main", branch: "main", scenarioIds: [] }, policy))
      .resolves.toMatchObject({ verified: [], failed: [], raised: [] });
    expect(port.run).not.toHaveBeenCalled();
  });

  it("records the revision it swept so a later bisect knows where it started", async () => {
    const port = { run: vi.fn(async () => ({
      revision: "abc123",
      outcomes: [{ scenarioId: "S-M2-01-a", outcome: "passed" as const }],
    })) };

    await new RegressionSweeper(registry, store, port)
      .sweep({ pool: "main", branch: "main", scenarioIds: ["S-M2-01-a"] }, policy);

    const row = (await client.execute("SELECT revision, pool FROM regression_runs")).rows[0];
    expect(row).toMatchObject({ revision: "abc123", pool: "main" });
  });
});
