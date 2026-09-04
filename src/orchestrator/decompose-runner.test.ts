// oxlint-disable unicorn/no-thenable -- the scenario grammar names a "then" field
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { EpicDecomposer, type DecomposeRequest } from "./decompose-runner.js";
import { answerBlocker } from "./epic-blocker.js";
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
    // The plan goes to the page and the card moves to the waiting-for-approval column together.
    const outbox = (await client.execute("SELECT operation FROM notion_outbox ORDER BY id")).rows;
    expect(outbox).toMatchObject([{ operation: "present_epic_plan" }, { operation: "sync_epic_status" }]);
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
      question: { question: "这批 Story 面向哪个客户群？" },
    });
    expect(port.run).toHaveBeenCalledTimes(1);
    expect(await state()).toBe("BLOCKED");
    expect((await client.execute("SELECT COUNT(*) AS count FROM stories")).rows[0]?.count).toBe(0);
    // The question goes to the Epic page, where the person will read it.
    const comment = (await client.execute("SELECT payload FROM notion_outbox WHERE operation = 'comment_epic_page'")).rows[0];
    expect(String(comment?.payload)).toContain("这批 Story 面向哪个客户群？");
  });

  it("decomposes again with the person's answer once they reply on the page", async () => {
    const asking = { run: vi.fn(async () => ({ ...plan, stories: [], blockingQuestion: "这批 Story 面向哪个客户群？" })) };
    await new EpicDecomposer(client, approvals, asking, () => 1_000).decompose(epic());
    expect(await answerBlocker(client, "M2", "comment-1", "面向已付费的企业客户", () => 2_000)).toBe(true);
    expect(await state()).toBe("DECOMPOSE");
    // The same comment delivered twice is one answer.
    expect(await answerBlocker(client, "M2", "comment-1", "面向已付费的企业客户", () => 2_100)).toBe(false);

    const planning = { run: vi.fn(async (_input: DecomposeRequest) => plan) };
    await expect(new EpicDecomposer(client, approvals, planning, () => 3_000).decompose(epic()))
      .resolves.toMatchObject({ kind: "presented" });
    const request = planning.run.mock.calls[0]![0];
    expect(request.requirement).toContain("多个 Story 并行推进并合成一次评审。");
    expect(request.requirement).toContain("问：这批 Story 面向哪个客户群？");
    expect(request.requirement).toContain("答：面向已付费的企业客户");
  });

  it("puts the options on the Epic page and expands the letter the person answers with", async () => {
    const question = {
      question: "这批 Story 面向哪个客户群？",
      context: "两类客户的验收场景不同。",
      options: [{ label: "已付费的企业客户", recommended: true }, { label: "所有注册客户" }],
    };
    const asking = { run: vi.fn(async () => ({ ...plan, stories: [], blockingQuestion: question })) };
    await new EpicDecomposer(client, approvals, asking, () => 1_000).decompose(epic());
    const comment = (await client.execute("SELECT payload FROM notion_outbox WHERE operation = 'comment_epic_page'")).rows[0];
    const body = (JSON.parse(String(comment?.payload)) as { body: string }).body;
    expect(body).toContain("A. 已付费的企业客户（推荐）");
    expect(body).toContain("B. 所有注册客户");
    expect(body).toContain("其他：");

    expect(await answerBlocker(client, "M2", "comment-1", "B", () => 2_000)).toBe(true);
    const planning = { run: vi.fn(async (_input: DecomposeRequest) => plan) };
    await new EpicDecomposer(client, approvals, planning, () => 3_000).decompose(epic());
    const request = planning.run.mock.calls[0]![0];
    expect(request.requirement).toContain("A. 已付费的企业客户（推荐）");
    expect(request.requirement).toContain("答：B\n（系统解读：选 B = 所有注册客户）");
  });

  it("refuses an Epic that is not waiting to be decomposed", async () => {
    await client.execute("UPDATE epics SET state = 'EXECUTING' WHERE id = 'M2'");
    const decomposer = new EpicDecomposer(client, approvals, { run: vi.fn() }, () => 1_000);

    await expect(decomposer.decompose(epic())).rejects.toThrow(/EXECUTING/);
  });
});
