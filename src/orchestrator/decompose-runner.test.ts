// oxlint-disable unicorn/no-thenable -- the scenario grammar names a "then" field
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { EpicDecomposer } from "./decompose-runner.js";
import { PlanApprovalStore } from "./plan-approval.js";
import type { DecompositionCandidate } from "./decompose.js";

const plan: DecompositionCandidate = {
  epicId: "M2",
  businessGoal: "客户在一次评审里看到整个提案。",
  stories: [{
    id: "S-M2-01",
    title: "客户看到提案概要",
    requirement: "客户打开提案时先看到整体结论。",
    scenarios: [{ id: "S-M2-01-a", given: "客户收到提案", when: "客户打开提案", then: "客户先看到整体结论" }],
    dependsOn: [],
    predictedFootprint: ["src/orchestrator"],
  }],
};

function epic() {
  return { id: "M2", notionPageId: "epic-page", title: "并行与回归", requirement: "多个 Story 并行推进并合成一次评审。" };
}

describe("EpicDecomposer", () => {
  let client: ReturnType<typeof createClient>;
  let approvals: PlanApprovalStore;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    approvals = new PlanApprovalStore(client, () => 1_000);
    await client.execute({
      sql: "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES (?, ?, ?, 'INTAKE', 1, 1)",
      args: ["M2", "epic-page", "并行与回归"],
    });
  });

  afterEach(() => client.close());

  async function state(): Promise<string> {
    return String((await client.execute("SELECT state FROM epics WHERE id = 'M2'")).rows[0]?.state);
  }

  it("carries an accepted decomposition to the approval gate", async () => {
    const port = { run: vi.fn(async () => plan) };
    const decomposer = new EpicDecomposer(client, approvals, port, () => 1_000);

    await expect(decomposer.decompose(epic())).resolves.toMatchObject({ kind: "presented" });
    expect(await state()).toBe("PLAN_APPROVAL");
    const outbox = (await client.execute("SELECT operation FROM notion_outbox")).rows;
    expect(outbox).toMatchObject([{ operation: "present_epic_plan" }]);
  });

  it("feeds the rejection reasons back and tries once more before giving up", async () => {
    const implementationWords = {
      ...plan,
      businessGoal: "重构 orchestrator 的调度函数并新增 scheduler.ts。",
    };
    const port = { run: vi.fn(async () => implementationWords) };
    const decomposer = new EpicDecomposer(client, approvals, port, () => 1_000);

    await expect(decomposer.decompose(epic())).resolves.toMatchObject({ kind: "rejected" });
    expect(port.run).toHaveBeenCalledTimes(2);
    const second = port.run.mock.calls.at(1)?.at(0) as { previousRejections: readonly string[] } | undefined;
    expect(second?.previousRejections.length).toBeGreaterThan(0);
    expect(await state()).toBe("BLOCKED");
  });

  it("accepts a second attempt that fixed what the first got wrong", async () => {
    const port = { run: vi.fn(async (input: { previousRejections: readonly string[] }) =>
      (input.previousRejections.length === 0 ? { ...plan, businessGoal: "新增 scheduler.ts 模块。" } : plan)) };
    const decomposer = new EpicDecomposer(client, approvals, port, () => 1_000);

    await expect(decomposer.decompose(epic())).resolves.toMatchObject({ kind: "presented" });
    expect(await state()).toBe("PLAN_APPROVAL");
  });

  it("stops on a blocking question instead of inventing the missing requirement", async () => {
    // A blocking question is all or nothing: a partial Story list alongside it
    // is a rejection, not a question.
    const port = { run: vi.fn(async () => ({ ...plan, stories: [], blockingQuestion: "这批 Story 面向哪个客户群？" })) };
    const decomposer = new EpicDecomposer(client, approvals, port, () => 1_000);

    await expect(decomposer.decompose(epic())).resolves.toMatchObject({
      kind: "blocking_question",
      question: "这批 Story 面向哪个客户群？",
    });
    expect(port.run).toHaveBeenCalledTimes(1);
    expect(await state()).toBe("BLOCKED");
    expect((await client.execute("SELECT COUNT(*) AS count FROM stories")).rows[0]?.count).toBe(0);
  });

  it("refuses an Epic that is not waiting to be decomposed", async () => {
    await client.execute("UPDATE epics SET state = 'EXECUTING' WHERE id = 'M2'");
    const decomposer = new EpicDecomposer(client, approvals, { run: vi.fn() }, () => 1_000);

    await expect(decomposer.decompose(epic())).rejects.toThrow(/EXECUTING/);
  });
});
