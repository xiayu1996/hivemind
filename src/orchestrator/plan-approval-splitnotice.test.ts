import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { PlanApprovalStore } from "./plan-approval.js";

function plan(count: number) {
  return {
    epicId: `M${count}`,
    businessGoal: "Customers receive an ordered service plan.",
    stories: Array.from({ length: count }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      const id = `S-M${count}-${number}`;
      return {
        id, title: `Customer outcome ${number}`, requirement: `Customers receive outcome ${number}.`,
        scenarios: [{ id: `${id}-ready`, given: "a customer needs service", when: "the plan is approved", then: "the customer receives the outcome" }],
        dependsOn: [], predictedFootprint: ["service"],
      };
    }),
  };
}

describe("@scenario S-M2-06-splitnotice", () => {
  const clients: ReturnType<typeof createClient>[] = [];
  afterEach(() => clients.splice(0).forEach((client) => client.close()));

  it("presents a non-blocking human split recommendation for nine Stories but not eight", async () => {
    for (const count of [8, 9]) {
      const client = createClient({ url: ":memory:" });
      clients.push(client);
      await migrate(client);
      const approvals = new PlanApprovalStore(client, () => 1_000);
      await approvals.present({ epicId: `M${count}`, notionPageId: `page-${count}`, title: "Plan", plan: plan(count) });
      const payload = String((await client.execute("SELECT payload FROM notion_outbox")).rows[0]?.payload);
      expect(payload).toContain("拆解待确认");
      expect(payload.includes("建议考虑拆分 Epic")).toBe(count === 9);
      expect((await approvals.getEpic(`M${count}`)).state).toBe("PLAN_APPROVAL");
    }
  });
});
