import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { enqueueEpicPages, epicPagePayload, renderEpicProgress } from "./epic-page-projection.js";

describe("Epic page projection", () => {
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, integration_branch, mr_url, created_at, updated_at) VALUES ('E1','epic-page','Epic','EPIC_ACCEPT','epic/E1','https://example.test/pull/26',1,1)",
    );
    await client.batch([
      "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, mr_url, created_at, updated_at) VALUES ('S-E1-01','E1','p1','First','r','DELIVERED','https://example.test/pull/20',1,1)",
      "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at) VALUES ('S-E1-02','E1','p2','Second','r','NEEDS_INPUT','verify_loop_exceeded',2,2)",
    ], "write");
  });

  afterEach(() => client.close());

  it("says which column the Epic is in, where its review request is, and how each Story stands", async () => {
    const payload = await epicPagePayload(client, "E1");
    expect(payload).toMatchObject({ status: "验收中", mrUrl: "https://example.test/pull/26", integrationBranch: "epic/E1" });
    const rendered = renderEpicProgress(payload!);
    expect(rendered.lead[0]).toContain("https://example.test/pull/26");
    expect(rendered.lead[0]).toContain("main");
    expect(rendered.stories).toEqual([
      "S-E1-01 First — 已交付，MR https://example.test/pull/20",
      "S-E1-02 Second — 等你回答（验证轮次用完）",
    ]);
  });

  it("says which Stories an Epic is blocked on in the reader's words", async () => {
    await client.batch([
      "UPDATE epics SET state = 'BLOCKED' WHERE id = 'E1'",
      { sql: "INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data) VALUES ('epic:E1', 0, NULL, NULL, 'epic.transition', 5, ?)",
        args: [JSON.stringify({ from: "EXECUTING", to: "BLOCKED", reason: "Story S-E1-02 stopped: verify_loop_exceeded", escalation: true })] },
    ], "write");
    const payload = await epicPagePayload(client, "E1");
    expect(payload).toMatchObject({ status: "受阻", blockedReason: "Story S-E1-02 stopped: verify_loop_exceeded" });
    // The operator's line stays in the payload; the page shows the person's.
    expect(renderEpicProgress(payload!).lead.at(-1)).toBe("受阻：在等你回答 S-E1-02");
  });

  it("queues one row per changed page and none for an unchanged one", async () => {
    expect(await enqueueEpicPages(client, "main", () => 10)).toBe(1);
    expect(await enqueueEpicPages(client, "main", () => 11)).toBe(0);
    await client.execute("UPDATE stories SET state = 'CODE', stop_reason = NULL WHERE id = 'S-E1-02'");
    expect(await enqueueEpicPages(client, "main", () => 12)).toBe(1);
    const rows = (await client.execute("SELECT operation, target FROM notion_outbox ORDER BY id")).rows;
    expect(rows).toEqual([
      { operation: "sync_epic_page", target: "epic-page:E1" },
      { operation: "sync_epic_page", target: "epic-page:E1" },
    ]);
  });
});
