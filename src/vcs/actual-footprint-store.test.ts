import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { LibsqlActualFootprintStore, recoverActualFootprints } from "./actual-footprint.js";

describe("S-M2-07-store actual footprint persistence", () => {
  let client: ReturnType<typeof createClient>;
  let store: LibsqlActualFootprintStore;
  let time: number;

  async function seedStory(id: string): Promise<void> {
    await new StoryExecutionStore(client, () => time).createStory({
      id,
      notionPageId: `page-${id}`,
      title: id,
      requirement: "A merged Story records the directories it actually touched.",
      branch: `story/${id}`,
    });
  }

  async function storyFootprint(id: string): Promise<unknown> {
    const rows = (await client.execute({ sql: "SELECT actual_footprint FROM stories WHERE id = ?", args: [id] })).rows;
    return rows[0]?.actual_footprint ?? null;
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    time = 5_000;
    store = new LibsqlActualFootprintStore(client, () => time);
  });

  afterEach(() => {
    client.close();
  });

  it("applies a captured footprint onto the Story and stamps the capture with the injected clock", async () => {
    await seedStory("S-EPIC1-01");
    await store.capture({
      storyId: "S-EPIC1-01",
      integrationBranch: "epic/E-1",
      baseRevision: "base",
      storyRevision: "story",
      actualFootprint: ["src/vcs"],
    });
    await expect(storyFootprint("S-EPIC1-01")).resolves.toBeNull();

    time = 6_000;
    await store.apply("S-EPIC1-01");

    await expect(storyFootprint("S-EPIC1-01")).resolves.toBe('["src/vcs"]');
    await expect(store.pending()).resolves.toEqual([]);
    const capture = (await client.execute("SELECT state, created_at, applied_at FROM actual_footprint_captures")).rows[0];
    expect(capture).toMatchObject({ state: "applied", created_at: 5_000, applied_at: 6_000 });
  });

  it("refreshes a pending capture when the same Story is re-merged from a newer revision", async () => {
    await seedStory("S-EPIC1-01");
    await store.capture({
      storyId: "S-EPIC1-01",
      integrationBranch: "epic/E-1",
      baseRevision: "base",
      storyRevision: "stale",
      actualFootprint: ["src/vcs"],
    });
    await store.capture({
      storyId: "S-EPIC1-01",
      integrationBranch: "epic/E-1",
      baseRevision: "base",
      storyRevision: "fresh",
      actualFootprint: ["src/console", "src/vcs"],
    });

    await expect(store.pending()).resolves.toEqual([{
      storyId: "S-EPIC1-01",
      integrationBranch: "epic/E-1",
      baseRevision: "base",
      storyRevision: "fresh",
      actualFootprint: ["src/console", "src/vcs"],
    }]);
    await store.apply("S-EPIC1-01");
    await expect(storyFootprint("S-EPIC1-01")).resolves.toBe('["src/console","src/vcs"]');
  });

  it("recovers only captures whose Story revision already landed on the integration branch", async () => {
    await seedStory("S-EPIC1-01");
    await seedStory("S-EPIC1-02");
    for (const [id, revision] of [["S-EPIC1-01", "landed"], ["S-EPIC1-02", "orphan"]] as const) {
      await store.capture({
        storyId: id,
        integrationBranch: "epic/E-1",
        baseRevision: "base",
        storyRevision: revision,
        actualFootprint: [`src/${id}`],
      });
    }
    const git = { run: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "merge-base" && args[2] === "orphan") throw new Error("not an ancestor");
      return "";
    }) };

    await recoverActualFootprints(git, "integration", store);

    await expect(storyFootprint("S-EPIC1-01")).resolves.toBe('["src/S-EPIC1-01"]');
    await expect(storyFootprint("S-EPIC1-02")).resolves.toBeNull();
    await expect(store.pending()).resolves.toMatchObject([{ storyId: "S-EPIC1-02" }]);
  });
});
