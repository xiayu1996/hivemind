// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external PRD contract.
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { EpicAcceptance } from "./epic-acceptance.js";

const REQUIREMENT_ID = "R-abc123def456";

const PRD = JSON.stringify({
  businessGoal: "值班的人随时看到进度",
  nonGoals: [],
  scenarios: [
    { id: "s01", given: "值班的人打开首屏", when: "刷新页面", then: "看到全部在等人的卡片" },
    { id: "s02", given: "值班的人在手机上", when: "打开同一页", then: "看到同样的卡片" },
  ],
});

describe("EpicAcceptance", () => {
  let client: ReturnType<typeof createClient>;
  let acceptance: EpicAcceptance;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    acceptance = new EpicAcceptance(client, () => time++);
    await client.batch([
      {
        sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
              VALUES (?, 'req-page', '控制台', 'EXECUTING', '我想看到进度', 1, 1)`,
        args: [REQUIREMENT_ID],
      },
      {
        sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at, confirmed_at)
              VALUES (?, 1, ?, 'confirmed', 1, 1)`,
        args: [REQUIREMENT_ID, PRD],
      },
      {
        sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, repo, mr_url, created_at, updated_at)
              VALUES ('CONSOLE1', 'epic-page', '首屏', 'EPIC_ACCEPT', ?, 'owner/hivemind', 'https://example.test/pull/1', 1, 1)`,
        args: [REQUIREMENT_ID],
      },
      {
        sql: "INSERT INTO epic_prd_scenarios (requirement_id, epic_id, prd_scenario_id) VALUES (?, 'CONSOLE1', 's01')",
        args: [REQUIREMENT_ID],
      },
      {
        sql: "INSERT INTO epic_prd_scenarios (requirement_id, epic_id, prd_scenario_id) VALUES (?, 'CONSOLE1', 's02')",
        args: [REQUIREMENT_ID],
      },
    ], "write");
  });

  afterEach(() => client.close());

  it("asks about exactly the scenarios this batch carries, in the PRD's own words", async () => {
    const items = await acceptance.open("CONSOLE1");
    expect(items).toMatchObject([
      { prdScenarioId: "s01", status: "open", text: "值班的人打开首屏，刷新页面，看到全部在等人的卡片" },
      { prdScenarioId: "s02", status: "open" },
    ]);
    // Asking twice must not double the list a person is reading.
    await acceptance.open("CONSOLE1");
    expect(await acceptance.items("CONSOLE1")).toHaveLength(2);
  });

  it("has nothing to ask about an Epic nobody raised from a requirement", async () => {
    await client.execute("UPDATE epics SET requirement_id = NULL WHERE id = 'CONSOLE1'");
    expect(await acceptance.open("CONSOLE1")).toEqual([]);
    expect(await acceptance.settle("CONSOLE1")).toEqual({ kind: "unjudged" });
  });

  it("counts a tick as a verdict and an untouched box as none", async () => {
    await acceptance.open("CONSOLE1");
    await acceptance.bindBlock("CONSOLE1", "s01", "box-s01");

    expect(await acceptance.applyCheck("CONSOLE1", "box-s01")).toBe(true);
    // The same box read again by the fallback poll is not a second verdict.
    expect(await acceptance.applyCheck("CONSOLE1", "box-s01")).toBe(false);
    expect(await acceptance.settle("CONSOLE1")).toEqual({ kind: "waiting", open: 1 });
  });

  it("turns what the person says is missing into one more Story under this Epic", async () => {
    await acceptance.open("CONSOLE1");
    await acceptance.bindBlock("CONSOLE1", "s01", "box-s01");
    await acceptance.applyCheck("CONSOLE1", "box-s01");
    expect(await acceptance.recordGap("CONSOLE1", "s02", "手机上打开是空白的")).toBe(true);

    const settled = await acceptance.settle("CONSOLE1");
    expect(settled).toMatchObject({ kind: "gap", storyIds: ["S-CONSOLE1-01"] });
    const story = (await client.execute("SELECT epic_id, state, requirement, repo FROM stories")).rows[0];
    expect(story).toMatchObject({ epic_id: "CONSOLE1", state: "QUEUED", repo: "owner/hivemind" });
    expect(String(story?.requirement)).toContain("手机上打开是空白的");
    expect(String(story?.requirement)).toContain("看到同样的卡片");
    // The batch is not finished after all: it goes back to work, and the
    // review request it had is no longer the one to merge.
    expect((await client.execute("SELECT state, mr_url FROM epics WHERE id = 'CONSOLE1'")).rows[0])
      .toMatchObject({ state: "EXECUTING", mr_url: null });
    expect((await client.execute("SELECT story_id FROM execution_dispatches")).rows)
      .toEqual([{ story_id: "S-CONSOLE1-01" }]);
  });

  it("puts a rejected scenario back up for judgement once the work for it is delivered", async () => {
    await acceptance.open("CONSOLE1");
    await acceptance.bindBlock("CONSOLE1", "s01", "box-s01");
    await acceptance.applyCheck("CONSOLE1", "box-s01");
    await acceptance.recordGap("CONSOLE1", "s02", "手机上打开是空白的");
    await acceptance.settle("CONSOLE1");

    await acceptance.open("CONSOLE1");
    expect(await acceptance.items("CONSOLE1")).toMatchObject([
      // What they already approved stays approved: making somebody judge the
      // same thing twice teaches them to click without reading.
      { prdScenarioId: "s01", status: "accepted" },
      { prdScenarioId: "s02", status: "open", note: null },
    ]);
  });

  it("finishes the round when every scenario has been ticked", async () => {
    await acceptance.open("CONSOLE1");
    await acceptance.bindBlock("CONSOLE1", "s01", "box-s01");
    await acceptance.bindBlock("CONSOLE1", "s02", "box-s02");
    await acceptance.applyCheck("CONSOLE1", "box-s01");
    await acceptance.applyCheck("CONSOLE1", "box-s02");
    expect(await acceptance.settle("CONSOLE1")).toEqual({ kind: "accepted" });
  });
});
