// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external decomposition contract.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SystemOne, SystemOneRequest } from "../judge/system-one.js";
import { planRevisionFeedback } from "../orchestrator/epic-blocker.js";
import { PlanApprovalStore } from "../orchestrator/plan-approval.js";
import { migrate } from "../persistence/migrate.js";
import { CommentIngestor, type NotionCommentSource } from "./comment-ingest.js";
import { NotionEpicInputSync } from "./epic-input-sync.js";
import type { NotionGateway } from "./gateway.js";

let client: Client;

const plan = {
  epicId: "M2",
  businessGoal: "People approve a proposed plan before work begins.",
  stories: [{
    id: "S-M2-02",
    title: "Approve a plan",
    requirement: "A person can approve a plan.",
    userEntryPoint: "the S-M2-02 view a person opens",
    verificationPath: "open the S-M2-02 view and check the outcome",
    scenarios: [{ id: "S-M2-02-comment", given: "a plan awaits approval", when: "a human approves it", then: "execution begins" }],
    dependsOn: [],
    predictedFootprint: ["orchestrator"],
  }],
};

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

afterEach(() => client.close());

function gateway(status: string): NotionGateway {
  return {
    request: async () => ({ data: {
      properties: { "Epic 状态": { type: "select", select: { name: status } } },
    } }),
  } as unknown as NotionGateway;
}

describe("@scenario S-M2-02-comment Notion sync approval", () => {
  it("ingests an Epic-page approval comment through the active sync path and dispatches once", async () => {
    const approvals = new PlanApprovalStore(client, () => 1_000, { planApproval: true });
    await approvals.present({ epicId: "M2", notionPageId: "epic-page", title: "Plan", plan });
    const source: NotionCommentSource = {
      listComments: async () => [{
        id: "comment-approve", pageId: "epic-page", blockId: null, discussionId: "discussion-1",
        authorId: "human-1", body: "批准", createdTime: 1_000,
      }],
    };
    const comments = new CommentIngestor(client, source, { now: () => 1_000 });
    await comments.registerPage("epic-page", []);
    const sync = new NotionEpicInputSync(client, gateway("拆解待确认"), comments, approvals, () => 1_000);

    await expect(sync.pollComments("epic-page")).resolves.toMatchObject({ approved: 1 });
    await expect(sync.pollComments("epic-page")).resolves.toMatchObject({ approved: 0 });
    expect(await approvals.getEpic("M2")).toMatchObject({ state: "EXECUTING" });
    expect((await client.execute("SELECT story_id FROM execution_dispatches")).rows).toEqual([{ story_id: "S-M2-02" }]);
  });
});

describe("@scenario S-M2-02-drag Notion sync approval", () => {
  it("ingests the Epic status drag through the active sync path", async () => {
    const approvals = new PlanApprovalStore(client, () => 1_000, { planApproval: true });
    await approvals.present({ epicId: "M2", notionPageId: "epic-page", title: "Plan", plan });
    const comments = new CommentIngestor(client, { listComments: async () => [] }, { now: () => 1_000 });
    const sync = new NotionEpicInputSync(client, gateway("进行中"), comments, approvals, () => 1_000);

    await expect(sync.pollProperties("epic-page")).resolves.toMatchObject({ intent: "approve_plan", approved: true });
    expect((await client.execute("SELECT story_id FROM execution_dispatches")).rows).toEqual([{ story_id: "S-M2-02" }]);
  });
});

describe("@scenario S-M2-02-revise Notion sync approval", () => {
  it("returns an Epic to decomposition when its page receives an unambiguous revision request", async () => {
    const approvals = new PlanApprovalStore(client, () => 1_000, { planApproval: true });
    await approvals.present({ epicId: "M2", notionPageId: "epic-page", title: "Plan", plan });
    const comments = new CommentIngestor(client, {
      listComments: async () => [{
        id: "comment-revise", pageId: "epic-page", blockId: null, discussionId: "discussion-1",
        authorId: "human-1", body: "请修改拆解方案", createdTime: 1_000,
      }],
    }, { now: () => 1_000 });
    await comments.registerPage("epic-page", []);
    const sync = new NotionEpicInputSync(client, gateway("拆解待确认"), comments, approvals, () => 1_000);

    await expect(sync.pollComments("epic-page")).resolves.toMatchObject({ revised: 1 });
    expect(await approvals.getEpic("M2")).toMatchObject({ state: "DECOMPOSE" });
    expect((await client.execute("SELECT story_id FROM execution_dispatches")).rows).toEqual([]);
  });
});

describe("plan approval the four strings do not match", () => {
  async function pollWith(body: string, noul: number): Promise<{
    approved: number;
    asked: SystemOneRequest[];
    friction: { cardId: string; kind: string; detail: string }[];
  }> {
    const approvals = new PlanApprovalStore(client, () => 1_000, { planApproval: true });
    await approvals.present({ epicId: "M2", notionPageId: "epic-page", title: "Plan", plan });
    const comments = new CommentIngestor(client, {
      listComments: async () => [{
        id: "comment-1", pageId: "epic-page", blockId: null, discussionId: "discussion-1",
        authorId: "human-1", body, createdTime: 1_000,
      }],
    }, { now: () => 1_000 });
    await comments.registerPage("epic-page", []);
    const asked: SystemOneRequest[] = [];
    const judge: SystemOne = {
      async ask(request) {
        asked.push(request);
        return { answers: { is_approval: { type: "noul", noul } } };
      },
    };
    const friction: { cardId: string; kind: string; detail: string }[] = [];
    const sync = new NotionEpicInputSync(
      client, gateway("拆解待确认"), comments, approvals, () => 1_000, undefined,
      { judge, model: "jev-latest", threshold: 0.8 },
      async (input) => { friction.push(input); },
    );
    const result = await sync.pollComments("epic-page");
    return { approved: result.approved, asked, friction };
  }

  it("approves the plan on a wording the judge vouched for", async () => {
    // Without the judge this comment falls through to `feedback`, which is
    // silence: the Epic goes on waiting and nobody is told why.
    const { approved, asked, friction } = await pollWith("行，就这么干", 0.9);

    expect(approved).toBe(1);
    expect(asked[0]!.state).toEqual({ comment: "行，就这么干" });
    expect(friction).toMatchObject([{ cardId: "M2", kind: "notion_approval_judged" }]);
    expect(await new PlanApprovalStore(client, () => 1_000).getEpic("M2")).toMatchObject({ state: "EXECUTING" });
  });

  it("sends the plan back rather than approving it when the judge is not sure", async () => {
    // Bare praise is not an approval, so it does not start the work. It is not
    // silence either: the comment goes back with the plan, and the person who
    // wrote it sees a new split rather than a page that never moved.
    const { approved, friction } = await pollWith("这个拆解写得挺好的", 0.7);

    expect(approved).toBe(0);
    expect(friction).toEqual([]);
    expect(await new PlanApprovalStore(client, () => 1_000).getEpic("M2")).toMatchObject({ state: "DECOMPOSE" });
  });

  it("never asks about the wording the whitelist already approves", async () => {
    const { approved, asked } = await pollWith("批准", 0.01);

    expect(approved).toBe(1);
    expect(asked).toEqual([]);
  });
});

describe("a comment on a waiting plan", () => {
  async function pollWithComments(bodies: readonly string[]): Promise<PlanApprovalStore> {
    const approvals = new PlanApprovalStore(client, () => 1_000, { planApproval: true });
    await approvals.present({ epicId: "M2", notionPageId: "epic-page", title: "Plan", plan });
    const comments = new CommentIngestor(client, {
      listComments: async () => bodies.map((body, index) => ({
        id: `comment-${index}`, pageId: "epic-page", blockId: null, discussionId: "d",
        authorId: "human-1", body, createdTime: 1_000 + index,
      })),
    }, { now: () => 1_000 });
    await comments.registerPage("epic-page", []);
    const sync = new NotionEpicInputSync(client, gateway("拆解待确认"), comments, approvals, () => 1_000);
    await sync.pollComments("epic-page");
    return approvals;
  }

  it("sends the plan back carrying what the person said was wrong with it", async () => {
    // This used to be read as `feedback`, which does nothing at all: the Epic
    // went on waiting and nothing on the page said what it waited for.
    const said = "这个拆解不对，第二张卡应该拆成两张";

    const approvals = await pollWithComments([said]);

    expect(await approvals.getEpic("M2")).toMatchObject({ state: "DECOMPOSE" });
    await expect(planRevisionFeedback(client, "M2")).resolves.toEqual([said]);
  });

  it("carries everything written about one plan into one split", async () => {
    const approvals = await pollWithComments(["第二张卡应该拆成两张", "另外第四张不该依赖第一张"]);

    expect(await approvals.getEpic("M2")).toMatchObject({ state: "DECOMPOSE" });
    await expect(planRevisionFeedback(client, "M2"))
      .resolves.toEqual(["第二张卡应该拆成两张\n另外第四张不该依赖第一张"]);
    // Both comments are spent. One left unclaimed would send the next plan
    // straight back the moment it arrived.
    expect((await client.execute("SELECT event_id FROM epic_approval_events ORDER BY event_id")).rows)
      .toEqual([{ event_id: "comment-0" }, { event_id: "comment-1" }]);
  });

  it("does not count an approval written after a request to change something", async () => {
    // They asked for a change and then said "批准"; what is on the page now is
    // not what they approved.
    const approvals = await pollWithComments(["第二张卡应该拆成两张", "批准"]);

    expect(await approvals.getEpic("M2")).toMatchObject({ state: "DECOMPOSE" });
  });

  it("still starts the work on an approval that stands alone", async () => {
    const approvals = await pollWithComments(["批准"]);

    expect(await approvals.getEpic("M2")).toMatchObject({ state: "EXECUTING" });
    await expect(planRevisionFeedback(client, "M2")).resolves.toEqual([]);
  });
});

describe("blocked Epic", () => {
  it("reads the person's comment on a blocked Epic as the answer and sends it back to decomposition", async () => {
    await client.execute({
      sql: "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2', 'epic-page', 'M2 Plan', 'BLOCKED', 1, 1)",
    });
    await client.execute({
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES ('epic:M2', 0, NULL, 'DECOMPOSE', 'epic.transition', 500, ?)`,
      args: [JSON.stringify({ from: "DECOMPOSE", to: "BLOCKED", reason: "blocking question: 面向哪个客户群？" })],
    });
    const comments = new CommentIngestor(client, {
      listComments: async () => [{
        id: "comment-answer", pageId: "epic-page", blockId: null, discussionId: "discussion-1",
        authorId: "human-1", body: "面向已付费的企业客户", createdTime: 1_000,
      }],
    }, { now: () => 1_000 });
    await comments.registerPage("epic-page", []);
    const sync = new NotionEpicInputSync(client, gateway("待拆解"), comments, new PlanApprovalStore(client), () => 1_000);

    await expect(sync.pollComments("epic-page")).resolves.toMatchObject({ answered: 1 });
    expect((await client.execute("SELECT state FROM epics WHERE id = 'M2'")).rows[0]?.state).toBe("DECOMPOSE");
    await expect(sync.pollComments("epic-page")).resolves.toMatchObject({ answered: 0 });
  });
});
