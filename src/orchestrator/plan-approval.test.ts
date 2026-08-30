// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external decomposition contract.
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { interpretEpicComment, interpretEpicPropertyChange } from "../notion/intent-interpreter.js";
import { migrate } from "../persistence/migrate.js";
import { PlanApprovalStore } from "./plan-approval.js";

const plan = {
  epicId: "M2",
  businessGoal: "People can approve a proposed plan before work begins.",
  stories: [{
    id: "S-M2-02",
    title: "Approve a plan",
    requirement: "A person can approve a plan.",
    scenarios: [{ id: "S-M2-02-wait", given: "a plan waits", when: "nobody approves", then: "work does not begin" }],
    dependsOn: [],
    predictedFootprint: ["orchestrator"],
  }],
};

async function presentedPlan() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const approvals = new PlanApprovalStore(client, () => 1_000);
  await approvals.present({ epicId: "M2", notionPageId: "epic-page", title: "Plan approval", plan });
  return { client, approvals };
}

describe("@scenario S-M2-02-wait plan approval", () => {
  let client: ReturnType<typeof createClient>;
  let approvals: PlanApprovalStore;

  beforeEach(async () => ({ client, approvals } = await presentedPlan()));
  afterEach(() => client.close());

  it("keeps an unapproved Epic waiting without materializing or dispatching its Stories", async () => {
    expect(await approvals.getEpic("M2")).toMatchObject({ state: "PLAN_APPROVAL" });
    expect((await client.execute("SELECT id FROM stories")).rows).toEqual([]);
    expect((await client.execute("SELECT story_id FROM execution_dispatches")).rows).toEqual([]);
    expect((await client.execute("SELECT payload FROM notion_outbox")).rows).toContainEqual(expect.objectContaining({
      payload: expect.stringContaining("拆解待确认"),
    }));
  });
});

describe("@scenario S-M2-02-drag plan approval", () => {
  it("records a drag to 进行中 as approval and creates one eligible Story dispatch", async () => {
    expect(interpretEpicPropertyChange("拆解待确认", "进行中", "PLAN_APPROVAL", 1_000)).toEqual({
      type: "approve_plan", humanWinsUntil: 121_000,
    });
    const { client, approvals } = await presentedPlan();
    expect(await approvals.approve({ epicId: "M2", eventId: "drag-1", source: "drag" })).toBe(true);
    expect(await approvals.getEpic("M2")).toMatchObject({ state: "EXECUTING" });
    expect((await client.execute("SELECT id, state FROM stories")).rows).toEqual([{ id: "S-M2-02", state: "QUEUED" }]);
    expect((await client.execute("SELECT story_id, state FROM execution_dispatches")).rows).toEqual([
      { story_id: "S-M2-02", state: "pending" },
    ]);
    client.close();
  });
});

describe("@scenario S-M2-02-comment plan approval", () => {
  it("starts the Epic from an unambiguous Epic-page approval comment", async () => {
    expect(interpretEpicComment("PLAN_APPROVAL", "批准")).toEqual({ type: "approve_plan" });
    expect(interpretEpicComment("PLAN_APPROVAL", "Looks good to me")).toEqual({ type: "feedback" });
    const { client, approvals } = await presentedPlan();
    expect(await approvals.approve({ epicId: "M2", eventId: "comment-1", source: "comment" })).toBe(true);
    expect(await approvals.getEpic("M2")).toMatchObject({ state: "EXECUTING" });
    client.close();
  });
});

describe("@scenario S-M2-02-replay plan approval", () => {
  it("deduplicates webhook and polling replays before Stories and dispatches are materialized", async () => {
    const { client, approvals } = await presentedPlan();
    await Promise.all([
      approvals.approve({ epicId: "M2", eventId: "approval-1", source: "drag" }),
      approvals.approve({ epicId: "M2", eventId: "approval-1", source: "drag" }),
    ]);
    expect(await approvals.approvedEventCount("M2")).toBe(1);
    expect((await client.execute("SELECT story_id FROM execution_dispatches")).rows).toEqual([{ story_id: "S-M2-02" }]);
    client.close();
  });
});

describe("@scenario S-M2-02-revise plan approval", () => {
  it("returns an unapproved Epic to decomposition without starting its plan", async () => {
    const { client, approvals } = await presentedPlan();
    expect(await approvals.requestRevision("M2", "comment-revise")).toBe(true);
    expect(await approvals.getEpic("M2")).toMatchObject({ state: "DECOMPOSE" });
    expect((await client.execute("SELECT id FROM stories")).rows).toEqual([]);
    expect((await client.execute("SELECT story_id FROM execution_dispatches")).rows).toEqual([]);
    client.close();
  });
});
