// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcceptanceChecklist } from "../orchestrator/acceptance-checklist.js";
import { RequirementStore } from "../orchestrator/requirement-store.js";
import { migrate } from "../persistence/migrate.js";
import { CommentIngestor, type NotionComment } from "./comment-ingest.js";
import type { NotionGateway } from "./gateway.js";
import { NotionRequirementInputSync } from "./requirement-input-sync.js";

const REQUIREMENT_ID = "R-abc123def456";
const PAGE_ID = "requirement-page";
const PRD_BODY = JSON.stringify({
  businessGoal: "值班的人随时知道现在在做什么",
  nonGoals: [],
  scenarios: [
    { id: `${REQUIREMENT_ID}-s01`, given: "值班的人打开看板", when: "有一张卡在等人回答", then: "他一眼看到在等谁、等什么" },
    { id: `${REQUIREMENT_ID}-s02`, given: "值班的人在手机上", when: "他想知道今天交付了什么", then: "他看到今天已经交付的清单" },
  ],
  openQuestions: [],
});

describe("NotionRequirementInputSync", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let checklist: AcceptanceChecklist;
  let comments: NotionComment[];
  let status: string;
  let checkedBlocks: Set<string>;
  let sync: NotionRequirementInputSync;

  function gateway(): NotionGateway {
    return {
      request: async (request: { method: string; path: string }) => {
        if (request.path.startsWith("/v1/pages/")) {
          return { status: 200, data: { properties: { "需求状态": { select: { name: status } } } } };
        }
        if (request.path.startsWith("/v1/blocks/")) {
          const blockId = decodeURIComponent(request.path.slice("/v1/blocks/".length));
          return { status: 200, data: { type: "to_do", to_do: { checked: checkedBlocks.has(blockId) } } };
        }
        throw new Error(`unexpected request ${request.method} ${request.path}`);
      },
    } as unknown as NotionGateway;
  }

  function comment(id: string, body: string, createdTime: number, blockId: string | null = null): void {
    comments.push({ id, pageId: PAGE_ID, blockId, discussionId: null, authorId: "person", body, createdTime });
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    store = new RequirementStore(client, () => time++);
    checklist = new AcceptanceChecklist(client, store, { publish: async () => undefined }, () => 9_000);
    comments = [];
    status = "PRD 待确认";
    checkedBlocks = new Set();
    const ingestor = new CommentIngestor(client, { listComments: async () => comments }, { now: () => 50_000 });
    sync = new NotionRequirementInputSync(client, gateway(), ingestor, store, checklist, () => 50_000);
    await store.createRequirement({ id: REQUIREMENT_ID, notionPageId: PAGE_ID, title: "控制台", originalRequest: "我想随时知道现在在做什么。" });
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run");
    await store.saveDraftPrd(REQUIREMENT_ID, PRD_BODY, "run");
  });

  afterEach(() => client.close());

  it("takes the first look at the status column as the baseline, not as a drag", async () => {
    await expect(sync.pollProperties(REQUIREMENT_ID)).resolves.toMatchObject({ intent: "initialized" });
    await expect(sync.pollProperties(REQUIREMENT_ID)).resolves.toMatchObject({ intent: "none" });
  });

  it("confirms the PRD when the person writes approval under it", async () => {
    comment("c-approve", "批准", 2_000);
    const result = await sync.pollComments(REQUIREMENT_ID);
    expect(result).toMatchObject({ ingested: 1, prdConfirmed: true });
    await expect(store.getPrd(REQUIREMENT_ID)).resolves.toMatchObject({ revision: 1, status: "confirmed" });
    // A second delivery of the same comment changes nothing.
    await expect(sync.pollComments(REQUIREMENT_ID)).resolves.toMatchObject({ prdConfirmed: false });
  });

  it("carries everything the person asked to change into one rewrite", async () => {
    comment("c-1", "第二个场景漏了值班交接", 2_000);
    comment("c-2", "另外周报不要放进来", 2_100);
    await expect(sync.pollComments(REQUIREMENT_ID)).resolves.toMatchObject({ revisionRequested: true });
    await expect(store.getPrd(REQUIREMENT_ID)).resolves.toMatchObject({ revision: 1, status: "superseded" });
    await expect(store.prdRevisionFeedback(REQUIREMENT_ID)).resolves.toEqual(["第二个场景漏了值班交接\n另外周报不要放进来"]);
    // Both comments are spent; a later draft does not see them again.
    await store.saveDraftPrd(REQUIREMENT_ID, PRD_BODY, "run");
    await expect(sync.pollComments(REQUIREMENT_ID)).resolves.toMatchObject({ revisionRequested: false, prdConfirmed: false });
  });

  it("reads a drag to the decomposition column as PRD approval", async () => {
    await sync.pollProperties(REQUIREMENT_ID);
    status = "拆解执行中";
    await expect(sync.pollProperties(REQUIREMENT_ID)).resolves.toMatchObject({ intent: "approve_prd", applied: true });
    await expect(store.getPrd(REQUIREMENT_ID)).resolves.toMatchObject({ status: "confirmed" });
    const row = (await client.execute("SELECT notion_status_shadow, human_wins_until FROM requirements")).rows[0];
    expect(row?.notion_status_shadow).toBe("拆解执行中");
    expect(Number(row?.human_wins_until)).toBeGreaterThan(50_000);
  });

  it("parks on a drag to the parked column and restores exactly the state it left", async () => {
    await sync.pollProperties(REQUIREMENT_ID);
    status = "人工停靠";
    await expect(sync.pollProperties(REQUIREMENT_ID)).resolves.toMatchObject({ intent: "park", applied: true });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "HUMAN_PARKED", resumeState: "PRD_CONFIRM" });
    status = "PRD 待确认";
    await expect(sync.pollProperties(REQUIREMENT_ID)).resolves.toMatchObject({ intent: "resume", applied: true });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "PRD_CONFIRM" });
  });

  describe("under acceptance", () => {
    beforeEach(async () => {
      await store.confirmPrd(REQUIREMENT_ID, 1, "approve", "comment", "run");
      await store.transition(REQUIREMENT_ID, "PRD_CONFIRM", "DECOMPOSING", "system", "run");
      await store.transition(REQUIREMENT_ID, "DECOMPOSING", "EXECUTING", "system", "run");
      await client.execute({
        sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
              VALUES ('E1', 'epic-page', 'E1 交付', 'DONE', ?, 1, 1)`,
        args: [REQUIREMENT_ID],
      });
      await checklist.open(REQUIREMENT_ID);
      await store.bindAcceptanceBlock(REQUIREMENT_ID, "A01", "box-a01");
      await store.bindAcceptanceBlock(REQUIREMENT_ID, "A02", "box-a02");
      status = "待验收";
      await sync.pollProperties(REQUIREMENT_ID);
    });

    it("turns a ticked box into a verdict on that scenario, once", async () => {
      checkedBlocks.add("box-a01");
      await expect(sync.pollContent(REQUIREMENT_ID)).resolves.toEqual({ ticked: 1 });
      await expect(sync.pollContent(REQUIREMENT_ID)).resolves.toEqual({ ticked: 0 });
      await expect(store.acceptanceItems(REQUIREMENT_ID)).resolves.toMatchObject([
        { itemId: "A01", status: "accepted" },
        { itemId: "A02", status: "open" },
      ]);
    });

    it("turns a comment on a box into a gap in the person's own words", async () => {
      comment("c-gap", "手机上打开是空白的", 3_000, "box-a02");
      comment("c-chat", "辛苦了", 3_100);
      await expect(sync.pollComments(REQUIREMENT_ID)).resolves.toMatchObject({ gapsRecorded: 1 });
      await expect(store.acceptanceItems(REQUIREMENT_ID)).resolves.toMatchObject([
        { itemId: "A01", status: "open" },
        { itemId: "A02", status: "gap" },
      ]);
      expect((await store.acceptanceGapNotes(REQUIREMENT_ID)).get("A02")).toBe("手机上打开是空白的");
    });

    it("reads a drag to accepted as a verdict on every scenario still open", async () => {
      checkedBlocks.add("box-a01");
      await sync.pollContent(REQUIREMENT_ID);
      status = "已验收";
      await expect(sync.pollProperties(REQUIREMENT_ID)).resolves.toMatchObject({ intent: "accept", applied: true });
      await expect(store.acceptanceItems(REQUIREMENT_ID)).resolves.toMatchObject([
        { itemId: "A01", status: "accepted" },
        { itemId: "A02", status: "accepted" },
      ]);
      await expect(checklist.settle(REQUIREMENT_ID)).resolves.toEqual({ kind: "accepted" });
    });
  });
});
