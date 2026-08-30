import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("@scenario S-M2-02-wait plan approval", () => {
  let client: ReturnType<typeof createClient>;
  let approvals: PlanApprovalStore;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    approvals = new PlanApprovalStore(client, () => 1_000);
    await approvals.present({
      epicId: "M2", notionPageId: "epic-page", title: "Plan approval", plan,
    });
  });

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
