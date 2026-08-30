import { createClient } from "@libsql/client";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { migrate } from "../persistence/migrate.js";
import { NotionMediaPipeline, type NotionMediaPort } from "./media.js";
import { NotionMediaReconciler } from "./media-reconciler.js";

async function fixture(path: string): Promise<{
  client: ReturnType<typeof createClient>;
  store: StoryExecutionStore;
}> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const store = new StoryExecutionStore(client, () => 100);
  await store.createStory({
    id: "S-EPIC1-01",
    notionPageId: "page-1",
    title: "Story",
    requirement: "Requirement",
  });
  await client.batch([{
    sql: `INSERT INTO verify_records
            (card_id, round, code_session_id, verify_session_id, verdict,
             failed_scenarios, evidence_dir, screenshots, created_at)
          VALUES (?, 1, 'code-1', 'verify-1', 'accepted', '[]', ?, ?, 100)`,
    args: ["S-EPIC1-01", path, JSON.stringify([{ scenarioId: "S-EPIC1-01-a", path: "shot.png" }])],
  }, {
    sql: `INSERT INTO notion_verification_rounds
            (story_id, round, toggle_block_id, summary, created_at)
          VALUES ('S-EPIC1-01', 1, 'toggle-1', 'Passed', 100)`,
    args: [],
  }], "write");
  return { client, store };
}

describe("NotionMediaReconciler", () => {
  it("uploads each verified screenshot once and remembers the remote upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hm-media-reconcile-"));
    await writeFile(join(directory, "shot.png"), Buffer.from([1, 2, 3]));
    const { client } = await fixture(directory);
    const upload = vi.fn(async () => ({ uploadId: "upload-1" }));
    const attach = vi.fn(async () => undefined);
    const port: NotionMediaPort = {
      upload,
      attach,
      attachPlaceholder: async () => undefined,
    };
    const reconciler = new NotionMediaReconciler(
      client,
      new NotionMediaPipeline(port),
      { now: () => 200 },
    );

    await expect(reconciler.reconcile()).resolves.toEqual({ queued: 1, skipped: 0 });
    await reconciler.waitForIdle();
    await expect(reconciler.reconcile()).resolves.toEqual({ queued: 0, skipped: 1 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith("toggle-1", "upload-1", "S-EPIC1-01-a evidence, round 1");
    const row = (await client.execute("SELECT status, upload_id FROM notion_media_delivery")).rows[0];
    expect(row).toMatchObject({ status: "uploaded", upload_id: "upload-1" });
    client.close();
  });

  it("persists a delivered text placeholder when the screenshot cannot be uploaded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hm-media-placeholder-"));
    const { client } = await fixture(directory);
    const placeholder = vi.fn(async () => undefined);
    const reconciler = new NotionMediaReconciler(
      client,
      new NotionMediaPipeline({
        upload: async () => { throw new Error("missing evidence"); },
        attach: async () => undefined,
        attachPlaceholder: placeholder,
      }),
      { now: () => 200 },
    );

    await reconciler.reconcile();
    await reconciler.waitForIdle();
    expect(placeholder).toHaveBeenCalledWith("toggle-1", expect.stringContaining("Image unavailable"));
    const row = (await client.execute("SELECT status, failure FROM notion_media_delivery")).rows[0];
    expect(row).toMatchObject({ status: "placeholder", failure: expect.stringContaining("ENOENT") });
    client.close();
  });
});
