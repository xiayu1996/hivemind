import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequirementStore } from "../orchestrator/requirement-store.js";
import { migrate } from "../persistence/migrate.js";
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

  it("writes the whole conversation into one durable page projection", async () => {
    await store.openClarifyRound(REQUIREMENT_ID, ["谁会用它？"], "run-ask");
    await store.recordClarifyAnswers(REQUIREMENT_ID, 1, ["值班的人"], "run-answer");
    await projector.publish(REQUIREMENT_ID);

    const rows = (await client.execute("SELECT operation, target, payload FROM notion_outbox")).rows;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(String(rows[0]!.payload)) as {
      status: string;
      desired: { metadata: string; original: string; clarify: string[]; prdFrozen: boolean };
    };
    expect(rows[0]!.operation).toBe("sync_requirement_page");
    expect(rows[0]!.target).toBe("requirement-page");
    expect(payload.status).toBe(STATUS[1]);
    expect(payload.desired.original).toBe("我想随时知道现在在做什么。");
    expect(payload.desired.clarify).toEqual(["第 1 轮 问 1: 谁会用它？", "第 1 轮 答 1: 值班的人"]);
    expect(payload.desired.metadata).toContain("澄清轮次: 1");
    expect(payload.desired.prdFrozen).toBe(false);
  });

  it("publishes the same record only once, however often it is asked to", async () => {
    await projector.publish(REQUIREMENT_ID);
    await projector.publish(REQUIREMENT_ID);

    expect((await client.execute("SELECT COUNT(*) AS count FROM notion_outbox")).rows[0]?.count).toBe(1);
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
      linkedEpics: [],
    });
    expect(draft.prdFrozen).toBe(false);
    expect(draft.prd).toEqual([
      "业务目标: 值班的人随时看到每张卡进行到哪一步",
      "本次不做: 这次不做权限",
      `场景 ${REQUIREMENT_ID}-s01: 给定 值班的人打开看板，当 有一张卡在等人回答，则 他一眼看到在等谁、等什么`,
      "待你裁决: 要不要给他发提醒？",
    ]);

    await store.confirmPrd(REQUIREMENT_ID, 1, "comment-1", "comment", "run-confirm");
    const frozen = buildRequirementPage({
      requirement: await store.getRequirement(REQUIREMENT_ID),
      clarify: [],
      prd: await store.getPrd(REQUIREMENT_ID),
      acceptance: [],
      linkedEpics: [],
    });
    expect(frozen.prdFrozen).toBe(true);
  });
});
