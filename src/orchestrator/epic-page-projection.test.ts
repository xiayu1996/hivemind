// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external PRD contract.
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { enqueueEpicPages, epicPagePayload, renderEpicPage } from "./epic-page-projection.js";

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

  it("says what this batch carries and how to review it, and nothing about where a Story is", async () => {
    await client.batch([
      { sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
              VALUES ('R1','req-page','\u9700\u6c42','EXECUTING','\u539f\u59cb\u9700\u6c42',1,1)` },
      { sql: `UPDATE epics SET requirement_id = 'R1', business_goal = '\u8ba9\u4eba\u80fd\u4fdd\u5b58\u4e00\u6761\u89c4\u5219' WHERE id = 'E1'` },
      { sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at, confirmed_at)
              VALUES ('R1', 1, ?, 'confirmed', 1, 1)`,
        args: [JSON.stringify({
          businessGoal: "\u8ba9\u4eba\u80fd\u4fdd\u5b58\u4e00\u6761\u89c4\u5219",
          nonGoals: [],
          scenarios: [
            { id: "s01", given: "\u7ba1\u7406\u5458\u6253\u5f00\u89c4\u5219\u9875", when: "\u4fdd\u5b58\u4e00\u6761\u89c4\u5219", then: "\u5217\u8868\u91cc\u51fa\u73b0\u5b83" },
            { id: "s02", given: "\u5220\u6389\u89c4\u5219", when: "\u5237\u65b0\u9875\u9762", then: "\u5217\u8868\u91cc\u6ca1\u6709\u5b83" },
          ],
        })] },
      "INSERT INTO epic_prd_scenarios (requirement_id, epic_id, prd_scenario_id) VALUES ('R1','E1','s01')",
      "UPDATE stories SET depends_on = '[\"S-E1-01\"]' WHERE id = 'S-E1-02'",
    ], "write");
    const payload = await epicPagePayload(client, "E1");
    expect(payload).toMatchObject({
      status: "\u9a8c\u6536\u4e2d",
      mrUrl: "https://example.test/pull/26",
      integrationBranch: "epic/E1",
      prdScenarios: [{ id: "s01" }],
    });
    const lines = renderEpicPage(payload!).lines.join("\n");
    expect(lines).toContain("\u8ba9\u4eba\u80fd\u4fdd\u5b58\u4e00\u6761\u89c4\u5219");
    expect(lines).toContain("\u7ba1\u7406\u5458\u6253\u5f00\u89c4\u5219\u9875\uff0c\u4fdd\u5b58\u4e00\u6761\u89c4\u5219\uff0c\u5217\u8868\u91cc\u51fa\u73b0\u5b83");
    // The scenario another Epic carries is not this Epic's to answer for.
    expect(lines).not.toContain("\u5217\u8868\u91cc\u6ca1\u6709\u5b83");
    // Where a Story stands belongs to the board, not to this page.
    expect(lines).not.toContain("\u5df2\u4ea4\u4ed8");
    expect(lines).not.toContain("\u7b49\u4f60\u56de\u7b54");
    expect(lines).toContain("graph TD");
    expect(lines).toContain("https://example.test/pull/26");
  });

  it("tells the person what to do when it is their turn, and says so plainly when it is not", async () => {
    const accepting = renderEpicPage((await epicPagePayload(client, "E1"))!);
    expect(accepting.callout.content).toContain("\u9a8c\u6536");
    await client.execute("UPDATE epics SET state = 'EXECUTING' WHERE id = 'E1'");
    const running = renderEpicPage((await epicPagePayload(client, "E1"))!);
    expect(running.callout.content).toBe("\u73b0\u5728\u6ca1\u6709\u7b49\u4f60\u5904\u7406\u7684\u4e8b\u3002");
  });

  it("queues one row per changed page and none for an unchanged one", async () => {
    expect(await enqueueEpicPages(client, "main", () => 10)).toBe(1);
    expect(await enqueueEpicPages(client, "main", () => 11)).toBe(0);
    await client.execute("UPDATE epics SET mr_url = 'https://example.test/pull/27' WHERE id = 'E1'");
    expect(await enqueueEpicPages(client, "main", () => 12)).toBe(1);
    const rows = (await client.execute("SELECT operation, target FROM notion_outbox ORDER BY id")).rows;
    expect(rows).toEqual([
      { operation: "sync_epic_page", target: "epic-page:E1" },
      { operation: "sync_epic_page", target: "epic-page:E1" },
    ]);
  });

  it("sends the page again when the board still shows a status the Epic has left", async () => {
    // Blocked, delivered, then unblocked: the page is byte for byte the one
    // that went out before it blocked, so the hash drops it and the board is
    // left reading the state in between.
    await client.execute("UPDATE epics SET notion_status_shadow = '验收中' WHERE id = 'E1'");
    expect(await enqueueEpicPages(client, "main", () => 10)).toBe(1);
    await client.execute("UPDATE notion_outbox SET state = 'sent', sent_at = 10");
    await client.batch([
      "UPDATE epics SET state = 'BLOCKED', notion_status_shadow = '受阻' WHERE id = 'E1'",
      "UPDATE epics SET state = 'EPIC_ACCEPT' WHERE id = 'E1'",
    ], "write");

    expect(await enqueueEpicPages(client, "main", () => 11)).toBe(1);
    const rows = (await client.execute("SELECT state FROM notion_outbox")).rows;
    expect(rows).toEqual([{ state: "pending" }]);
  });

  it("leaves a sent page alone once the board agrees with it", async () => {
    await client.execute("UPDATE epics SET notion_status_shadow = '验收中' WHERE id = 'E1'");
    expect(await enqueueEpicPages(client, "main", () => 10)).toBe(1);
    await client.execute("UPDATE notion_outbox SET state = 'sent', sent_at = 10");
    expect(await enqueueEpicPages(client, "main", () => 11)).toBe(0);
    const rows = (await client.execute("SELECT state FROM notion_outbox")).rows;
    expect(rows).toEqual([{ state: "sent" }]);
  });
});

describe("the acceptance section", () => {
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      `INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at)
       VALUES ('E1','epic-page','Epic','EPIC_ACCEPT',1,1)`,
      `INSERT INTO epic_acceptance_items (epic_id, prd_scenario_id, text, status, decided_at, created_at)
       VALUES ('E1','s01','管理员保存一条规则，列表里出现它','accepted',2,1)`,
      `INSERT INTO epic_acceptance_items (epic_id, prd_scenario_id, text, status, note, decided_at, created_at)
       VALUES ('E1','s02','删掉规则，列表里没有它','gap','删了以后还在',2,1)`,
    ], "write");
  });

  afterEach(() => client.close());

  it("shows one box per scenario, with what the person said about the ones they refused", async () => {
    const rendered = renderEpicPage((await epicPagePayload(client, "E1"))!);
    expect(rendered.acceptance?.items).toEqual([
      { prdScenarioId: "s01", line: "管理员保存一条规则，列表里出现它", checked: true },
      {
        prdScenarioId: "s02",
        line: "删掉规则，列表里没有它\n你说：删了以后还在",
        checked: false,
      },
    ]);
    // The page says what ticking means, so nobody has to look it up.
    expect(rendered.acceptance?.intro).toContain("勾上");
    expect(rendered.lines.join("\n")).toContain("验收");
  });

  it("has no acceptance section before the batch is up for judgement", async () => {
    await client.execute("DELETE FROM epic_acceptance_items");
    const rendered = renderEpicPage((await epicPagePayload(client, "E1"))!);
    expect(rendered.acceptance).toBeNull();
    expect(rendered.lines.join("\n")).not.toContain("验收中");
  });
});
