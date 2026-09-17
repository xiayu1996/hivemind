import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequirementStore } from "../orchestrator/requirement-store.js";
import { migrate } from "../persistence/migrate.js";
import type { DesiredRequirementPage } from "./blocks/requirement-page.js";
import { NotionOutbox } from "./outbox.js";
import { RequirementPageProjector, buildRequirementPage, requirementStatusFor } from "./requirement-projection.js";
import schema from "./notion-schema.json" with { type: "json" };

const REQUIREMENT_ID = "R-abc123def456";
const STATUS = schema.options.requirementStatus;

describe("requirementStatusFor", () => {
  it("separates a card nobody has asked about yet from one under discussion", () => {
    expect(requirementStatusFor("CLARIFY", 0)).toBe(STATUS[0]);
    expect(requirementStatusFor("CLARIFY", 2)).toBe(STATUS[1]);
  });

  it("shows a requirement the system gave up on in the column a person watches", () => {
    expect(requirementStatusFor("FAILED", 3)).toBe(STATUS[6]);
    expect(requirementStatusFor("HUMAN_PARKED", 3)).toBe(STATUS[6]);
  });
});

describe("RequirementPageProjector", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let outbox: NotionOutbox;
  let projector: RequirementPageProjector;

  async function lastDesired(): Promise<DesiredRequirementPage> {
    const rows = (await client.execute("SELECT payload FROM notion_outbox ORDER BY id")).rows;
    return (JSON.parse(String(rows.at(-1)!.payload)) as { desired: DesiredRequirementPage }).desired;
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    store = new RequirementStore(client, () => time++);
    outbox = new NotionOutbox(client, () => time++);
    projector = new RequirementPageProjector(store, outbox);
    await store.createRequirement({
      id: REQUIREMENT_ID,
      notionPageId: "requirement-page",
      title: "给 hivemind 做一个控制台",
      originalRequest: "我想随时知道现在在做什么。",
    });
  });

  afterEach(() => client.close());

  it("folds each clarification round into a line saying whether it still waits", async () => {
    await store.openClarifyRound(REQUIREMENT_ID, [
      { question: "谁会用它？", options: [{ label: "值班的人" }, { label: "所有人" }] },
    ], "run-ask");
    await projector.publish(REQUIREMENT_ID);
    expect((await lastDesired()).clarify).toEqual([{
      round: 1,
      line: "第 1 轮 · 1 题 · 等你回答",
      items: [{ question: "谁会用它？", options: ["A. 值班的人", "B. 所有人", "其他：以上都不合适，直接写你的答案"] }],
    }]);

    await store.recordClarifyAnswers(REQUIREMENT_ID, 1, ["A"], "run-answer");
    await projector.publish(REQUIREMENT_ID);
    const answered = (await lastDesired()).clarify[0]!;
    expect(answered.line).toBe("第 1 轮 · 1 题 · 已回答");
    // The letter alone is what a person types; the page keeps it and says
    // what it was read as, so a misread is visible without reopening the log.
    expect(answered.items[0]!.answer).toBe("A");
    expect(answered.items[0]!.reading).toContain("值班的人");
  });

  it("writes the request into the page only so the page can carry it once", async () => {
    await projector.publish(REQUIREMENT_ID);
    const desired = await lastDesired();
    expect(desired.original).toBe("我想随时知道现在在做什么。");
    const rows = (await client.execute("SELECT operation, target FROM notion_outbox")).rows;
    expect(rows).toEqual([{ operation: "sync_requirement_page", target: "requirement-page" }]);
  });

  it("publishes the same record only once, however often it is asked to", async () => {
    await projector.publish(REQUIREMENT_ID);
    await projector.publish(REQUIREMENT_ID);

    expect((await client.execute("SELECT COUNT(*) AS count FROM notion_outbox")).rows[0]?.count).toBe(1);
  });

  it("says what a person has to do, and says plainly when there is nothing", async () => {
    await projector.publish(REQUIREMENT_ID);
    expect((await lastDesired()).callout).toBe("回复本页最新一条评论，选字母即可。");

    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-1");
    await store.transition(REQUIREMENT_ID, "PRD_CONFIRM", "DECOMPOSING", "system", "run-2");
    await projector.publish(REQUIREMENT_ID);
    expect((await lastDesired()).callout).toBe("现在没有等你处理的事。");
  });

  it("puts the reason it stopped above the action, and takes it away once answered", async () => {
    await store.stopForHumanInput(REQUIREMENT_ID, "CLARIFY", "run-stop", "clarification did not converge in 3 rounds");
    await projector.publish(REQUIREMENT_ID);
    expect((await lastDesired()).callout)
      .toBe("停在这里：clarification did not converge in 3 rounds\n回复本页最新一条评论，选字母即可。");

    await store.clearStop(REQUIREMENT_ID, "run-answer");
    await projector.publish(REQUIREMENT_ID);
    expect((await lastDesired()).callout).toBe("回复本页最新一条评论，选字母即可。");
  });

  it("reports delivery without claiming to judge it: the Epics do that", async () => {
    await projector.publish(REQUIREMENT_ID);
    expect((await lastDesired()).delivery).toContain("Epic");
    expect((await lastDesired()).delivery).not.toContain("勾");
  });

  it("marks a confirmed PRD frozen so the page projection stops touching it", async () => {
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-1");
    await store.saveDraftPrd(REQUIREMENT_ID, JSON.stringify({
      businessGoal: "值班的人随时看到每张卡进行到哪一步",
      nonGoals: ["这次不做权限"],
      scenarios: [{
        id: `${REQUIREMENT_ID}-s01`,
        given: "值班的人打开看板",
        when: "有一张卡在等人回答",
        // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
        then: "他一眼看到在等谁、等什么",
      }],
      openQuestions: ["要不要给他发提醒？"],
    }), "run-prd");

    const draft = buildRequirementPage({
      requirement: await store.getRequirement(REQUIREMENT_ID),
      clarify: [],
      prd: await store.getPrd(REQUIREMENT_ID),
      acceptance: [],
    });
    expect(draft.prd).toEqual({
      goal: "值班的人随时看到每张卡进行到哪一步",
      nonGoals: ["这次不做权限"],
      scenarios: [{
        id: `${REQUIREMENT_ID}-s01`,
        given: "值班的人打开看板",
        when: "有一张卡在等人回答",
        // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
        then: "他一眼看到在等谁、等什么",
      }],
      openQuestions: ["要不要给他发提醒？"],
      frozen: false,
    });

    await store.confirmPrd(REQUIREMENT_ID, 1, "comment-1", "comment", "run-confirm");
    const frozen = buildRequirementPage({
      requirement: await store.getRequirement(REQUIREMENT_ID),
      clarify: [],
      prd: await store.getPrd(REQUIREMENT_ID),
      acceptance: [],
    });
    expect(frozen.prd?.frozen).toBe(true);
  });
});
