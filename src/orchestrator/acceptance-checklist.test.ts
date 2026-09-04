import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { AcceptanceChecklist, buildChecklist } from "./acceptance-checklist.js";
import { RequirementStore } from "./requirement-store.js";
import type { PrdScenario } from "./requirement-artifacts.js";

const REQUIREMENT_ID = "R-abc123def456";
const SCENARIOS: PrdScenario[] = [
  {
    id: `${REQUIREMENT_ID}-s01`,
    given: "值班的人打开看板",
    when: "有一张卡在等人回答",
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
    then: "他一眼看到在等谁、等什么",
  },
  {
    id: `${REQUIREMENT_ID}-s02`,
    given: "值班的人在手机上",
    when: "他想知道今天交付了什么",
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
    then: "他看到今天已经交付的清单",
  },
];

describe("buildChecklist", () => {
  it("gives every PRD scenario exactly one line a person can judge", () => {
    const items = buildChecklist(SCENARIOS);
    expect(items).toHaveLength(SCENARIOS.length);
    expect(items.map((item) => item.prdScenarioId)).toEqual(SCENARIOS.map((scenario) => scenario.id));
    expect(items[0]?.text).toContain("他一眼看到在等谁、等什么");
    expect(new Set(items.map((item) => item.itemId)).size).toBe(items.length);
  });
});

describe("AcceptanceChecklist", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let checklist: AcceptanceChecklist;

  async function addEpic(id: string, state: string): Promise<void> {
    await client.execute({
      sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, 1)`,
      args: [id, `page-${id}`, `${id} 交付批次`, state, REQUIREMENT_ID],
    });
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    store = new RequirementStore(client, () => time++);
    let epicTime = 5_000;
    checklist = new AcceptanceChecklist(client, store, { publish: async () => undefined }, () => epicTime++);
    await store.createRequirement({
      id: REQUIREMENT_ID,
      notionPageId: "requirement-page",
      title: "给 hivemind 做一个控制台",
      originalRequest: "我想随时知道现在在做什么。",
      repo: "owner/hivemind",
    });
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-1");
    await store.saveDraftPrd(REQUIREMENT_ID, JSON.stringify({
      businessGoal: "值班的人随时看到每张卡进行到哪一步",
      nonGoals: [],
      scenarios: SCENARIOS,
    }), "run-prd");
    await store.confirmPrd(REQUIREMENT_ID, 1, "comment-1", "comment", "run-confirm");
    await store.transition(REQUIREMENT_ID, "PRD_CONFIRM", "DECOMPOSING", "system", "run-2");
    await store.transition(REQUIREMENT_ID, "DECOMPOSING", "EXECUTING", "system", "run-3");
  });

  afterEach(() => client.close());

  it("refuses to ask for a verdict while work is still running", async () => {
    await addEpic("CONSOLE1", "EXECUTING");
    await expect(checklist.open(REQUIREMENT_ID)).rejects.toThrow(/still has Epics in flight/);
  });

  it("puts one checklist line per PRD scenario in front of the person", async () => {
    await addEpic("CONSOLE1", "DONE");
    const items = await checklist.open(REQUIREMENT_ID);

    expect(items).toHaveLength(2);
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "ACCEPTANCE" });
    await expect(store.acceptanceItems(REQUIREMENT_ID)).resolves.toMatchObject([
      { itemId: "A01", prdScenarioId: SCENARIOS[0]!.id, status: "open" },
      { itemId: "A02", prdScenarioId: SCENARIOS[1]!.id, status: "open" },
    ]);

    // A second pass must not double the list a person is reading.
    await checklist.open(REQUIREMENT_ID);
    await expect(store.acceptanceItems(REQUIREMENT_ID)).resolves.toHaveLength(2);
  });

  it("treats a tick as a verdict and an untick as no verdict at all", async () => {
    await addEpic("CONSOLE1", "DONE");
    await checklist.open(REQUIREMENT_ID);
    await store.bindAcceptanceBlock(REQUIREMENT_ID, "A01", "block-a01");

    await expect(checklist.applyCheck(REQUIREMENT_ID, "block-a01", false, "tick-0")).resolves.toBe(false);
    await expect(checklist.applyCheck(REQUIREMENT_ID, "block-a01", true, "tick-1")).resolves.toBe(true);
    await expect(checklist.applyCheck(REQUIREMENT_ID, "block-a01", true, "tick-1")).resolves.toBe(false);
    await expect(store.acceptanceItems(REQUIREMENT_ID)).resolves.toMatchObject([
      { itemId: "A01", status: "accepted" },
      { itemId: "A02", status: "open" },
    ]);
    await expect(checklist.settle(REQUIREMENT_ID)).resolves.toEqual({ kind: "waiting", open: 1 });
  });

  it("ends the requirement when every scenario is accepted", async () => {
    await addEpic("CONSOLE1", "DONE");
    await checklist.open(REQUIREMENT_ID);
    await store.decideAcceptanceItem(REQUIREMENT_ID, "A01", "accepted", "verdict-1", "comment", "run-a1");
    await store.decideAcceptanceItem(REQUIREMENT_ID, "A02", "accepted", "verdict-2", "comment", "run-a2");

    await expect(checklist.settle(REQUIREMENT_ID)).resolves.toEqual({ kind: "accepted" });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "DONE" });
  });

  it("turns a gap into one more delivery batch carrying the person's own words", async () => {
    await addEpic("CONSOLE1", "DONE");
    await checklist.open(REQUIREMENT_ID);
    await store.decideAcceptanceItem(REQUIREMENT_ID, "A01", "accepted", "verdict-1", "comment", "run-a1");
    await checklist.recordGap(REQUIREMENT_ID, "A02", "手机上打开是空白的", "verdict-2");

    const outcome = await checklist.settle(REQUIREMENT_ID);
    expect(outcome).toMatchObject({ kind: "gap" });
    const epic = outcome.kind === "gap" ? outcome.epic : undefined;
    expect(epic?.id).toBe("RABC123G1");
    expect(epic?.requirement).toContain("他看到今天已经交付的清单");
    expect(epic?.requirement).toContain("手机上打开是空白的");

    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "EXECUTING" });
    await expect(store.acceptanceItems(REQUIREMENT_ID)).resolves.toMatchObject([
      { itemId: "A01", status: "accepted" },
      { itemId: "A02", status: "open" },
    ]);
    const stored = (await client.execute("SELECT id, state, repo FROM epics WHERE id = 'RABC123G1'")).rows;
    expect(stored).toMatchObject([{ state: "INTAKE", repo: "owner/hivemind" }]);
    const outbox = (await client.execute("SELECT operation FROM notion_outbox WHERE card_id = 'RABC123G1'")).rows;
    expect(outbox).toMatchObject([{ operation: "create_epic_page" }]);
  });
});
