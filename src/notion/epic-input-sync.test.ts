// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external decomposition contract.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const approvals = new PlanApprovalStore(client, () => 1_000);
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
    const approvals = new PlanApprovalStore(client, () => 1_000);
    await approvals.present({ epicId: "M2", notionPageId: "epic-page", title: "Plan", plan });
    const comments = new CommentIngestor(client, { listComments: async () => [] }, { now: () => 1_000 });
    const sync = new NotionEpicInputSync(client, gateway("进行中"), comments, approvals, () => 1_000);

    await expect(sync.pollProperties("epic-page")).resolves.toMatchObject({ intent: "approve_plan", approved: true });
    expect((await client.execute("SELECT story_id FROM execution_dispatches")).rows).toEqual([{ story_id: "S-M2-02" }]);
  });
});

describe("@scenario S-M2-02-revise Notion sync approval", () => {
  it("returns an Epic to decomposition when its page receives an unambiguous revision request", async () => {
    const approvals = new PlanApprovalStore(client, () => 1_000);
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
