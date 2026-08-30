import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { EpicIntegrator } from "./epic-integration.js";
import { StoryExecutionStore } from "./story-execution-store.js";

describe("EpicIntegrator", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;

  async function seedStory(id: string, footprint: string[], state: string, integrated = false): Promise<void> {
    await client.batch([
      {
        sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, branch, predicted_footprint, created_at, updated_at)
              VALUES (?, 'M2', ?, ?, 'requirement', ?, ?, ?, ?, 1, 1)`,
        args: [id, `page-${id}`, id, state, state === "MERGE" ? "MERGE" : null, `story/${id.toLowerCase()}`, JSON.stringify(footprint)],
      },
      {
        sql: `INSERT INTO execution_dispatches (story_id, epic_id, state, created_at, integrated_at)
              VALUES (?, 'M2', ?, 1, ?)`,
        args: [id, integrated ? "integrated" : "dispatched", integrated ? 2 : null],
      },
      {
        sql: "INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES (?, ?, 1, 'text', 'pending')",
        args: [`${id}-a`, id],
      },
    ], "write");
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    store = new StoryExecutionStore(client, () => 100);
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2','epic-page','M2','EXECUTING',1,1)",
    );
  });

  afterEach(() => client.close());

  it("merges the Story and records that it is now part of the Epic head", async () => {
    await seedStory("S-M2-01", ["src/a"], "MERGE");
    const flow = { merge: vi.fn(async () => ({ kind: "merged" as const, integrationBranch: "epic/M2", scenarioIds: ["S-M2-01-a"] })) };

    await expect(new EpicIntegrator(client, store, flow).integrate("S-M2-01", "merge-run"))
      .resolves.toMatchObject({ kind: "merged" });

    const dispatch = (await client.execute("SELECT state FROM execution_dispatches WHERE story_id = 'S-M2-01'")).rows[0];
    expect(dispatch?.state).toBe("integrated");
    await expect(store.getStory("S-M2-01")).resolves.toMatchObject({ state: "MERGE" });
  });

  it("hands the Stories already on the Epic head to the merge flow so the subset can widen", async () => {
    await seedStory("S-M2-01", ["src/a"], "DELIVERED", true);
    await seedStory("S-M2-02", ["src/b"], "MERGE");
    const flow = { merge: vi.fn(async () => ({ kind: "merged" as const, integrationBranch: "epic/M2", scenarioIds: [] })) };

    await new EpicIntegrator(client, store, flow).integrate("S-M2-02", "merge-run");

    expect(flow.merge.mock.calls.at(0)?.at(0)).toMatchObject({
      epicId: "M2",
      story: { id: "S-M2-02", scenarioIds: ["S-M2-02-a"] },
      integratedStories: [{ id: "S-M2-01", predictedFootprint: ["src/a"], scenarioIds: ["S-M2-01-a"] }],
    });
  });

  it("returns a conflicted Story to CODE with the worktree left for the agent", async () => {
    await seedStory("S-M2-01", ["src/a"], "MERGE");
    const flow = { merge: vi.fn(async () => ({ kind: "conflict" as const, integrationBranch: "epic/M2", reason: "CONFLICT in src/a/x.ts" })) };

    await expect(new EpicIntegrator(client, store, flow).integrate("S-M2-01", "merge-run"))
      .resolves.toMatchObject({ kind: "conflict" });

    await expect(store.getStory("S-M2-01")).resolves.toMatchObject({ state: "CODE" });
    const events = (await client.execute("SELECT type FROM event_log WHERE card_id = 'S-M2-01'")).rows;
    expect(events).toMatchObject([{ type: "merge.conflict" }]);
    expect((await client.execute("SELECT state FROM execution_dispatches WHERE story_id = 'S-M2-01'")).rows[0]?.state)
      .toBe("dispatched");
  });

  it("returns a Story whose scenarios failed beside the Epic head to CODE", async () => {
    await seedStory("S-M2-01", ["src/a"], "MERGE");
    const flow = { merge: vi.fn(async () => ({
      kind: "verification_failed" as const,
      integrationBranch: "epic/M2",
      scenarioIds: ["S-M2-01-a"],
      reason: "subset re-verification rejected",
    })) };

    await expect(new EpicIntegrator(client, store, flow).integrate("S-M2-01", "merge-run"))
      .resolves.toMatchObject({ kind: "verification_failed" });

    await expect(store.getStory("S-M2-01")).resolves.toMatchObject({ state: "CODE" });
    expect((await client.execute("SELECT type FROM event_log WHERE card_id = 'S-M2-01'")).rows)
      .toMatchObject([{ type: "merge.verification_failed" }]);
  });

  it("refuses to integrate a Story that declares no scenarios", async () => {
    await client.batch([
      `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, branch, predicted_footprint, created_at, updated_at)
         VALUES ('S-M2-09','M2','page-9','nine','requirement','MERGE','MERGE','story/s-m2-09','[]',1,1)`,
      "INSERT INTO execution_dispatches (story_id, epic_id, state, created_at) VALUES ('S-M2-09','M2','dispatched',1)",
    ], "write");
    const flow = { merge: vi.fn() };

    await expect(new EpicIntegrator(client, store, flow).integrate("S-M2-09", "merge-run"))
      .rejects.toThrow(/scenario/);
    expect(flow.merge).not.toHaveBeenCalled();
  });
});

describe("EpicIntegrator branch bookkeeping", () => {
  it("records the branch the Epic lives on the first time a Story lands", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 100);
    await client.batch([
      "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2','epic-page','M2','EXECUTING',1,1)",
      `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, phase, branch, predicted_footprint, created_at, updated_at)
         VALUES ('S-M2-01','M2','p1','one','requirement','MERGE','MERGE','story/s-m2-01','[]',1,1)`,
      "INSERT INTO execution_dispatches (story_id, epic_id, state, created_at) VALUES ('S-M2-01','M2','dispatched',1)",
      "INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES ('S-M2-01-a','S-M2-01',1,'t','pending')",
    ], "write");
    const flow = { merge: vi.fn(async () => ({ kind: "merged" as const, integrationBranch: "epic/M2", scenarioIds: ["S-M2-01-a"] })) };

    await new EpicIntegrator(client, store, flow).integrate("S-M2-01", "merge-run");

    expect((await client.execute("SELECT integration_branch FROM epics WHERE id = 'M2'")).rows[0]?.integration_branch)
      .toBe("epic/M2");
    client.close();
  });
});
