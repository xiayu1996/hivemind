// oxlint-disable unicorn/no-thenable -- the scenario grammar names a "then" field
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { EpicDecomposer, type DecomposeRequest } from "./decompose-runner.js";
import { answerBlocker } from "./epic-blocker.js";
import { PlanApprovalStore } from "./plan-approval.js";
import type { DecompositionCandidate } from "./decompose.js";
import type { SystemOne, SystemOneRequest } from "../judge/system-one.js";

const plan: DecompositionCandidate = {
  epicId: "M2",
  businessGoal: "客户在一次评审里看到整个提案。",
  stories: [{
    id: "S-M2-01",
    title: "客户看到提案概要",
    requirement: "客户打开提案时先看到整体结论。",
    userEntryPoint: "the S-M2-01 view a person opens",
    verificationPath: "open the S-M2-01 view and check the outcome",
    scenarios: [{ id: "S-M2-01-a", given: "客户收到提案", when: "客户打开提案", then: "客户先看到整体结论" }],
    dependsOn: [],
    predictedFootprint: ["src/orchestrator"],
  }],
};

function epic() {
  return { id: "M2", notionPageId: "epic-page", title: "并行与回归", requirement: "多个 Story 并行推进并合成一次评审。" };
}

function judgeStub(answer: (sentence: string) => number): SystemOne & { asked: SystemOneRequest[] } {
  const asked: SystemOneRequest[] = [];
  return {
    asked,
    async ask(request) {
      asked.push(request);
      return {
        answers: {
          is_implementation: { type: "noul", noul: answer((request.state as { sentence: string }).sentence) },
        },
      };
    },
  };
}

describe("EpicDecomposer", () => {
  let client: ReturnType<typeof createClient>;
  let approvals: PlanApprovalStore;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    approvals = new PlanApprovalStore(client, () => 1_000, { planApproval: true });
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

  describe("construction language the word table cannot see", () => {
    /** Construction with none of the seventeen words the table keys on. */
    const missed = "引入缓存层以降低响应延迟";
    const planWithMiss: DecompositionCandidate = {
      ...plan,
      stories: [{ ...plan.stories[0]!, requirement: missed }],
    };

    it("refuses the plan and tells the next attempt why", async () => {
      const judge = judgeStub((sentence) => (sentence === missed ? 0.96 : 0.03));
      const requests: DecomposeRequest[] = [];
      const port = {
        run: async (input: DecomposeRequest) => {
          requests.push(input);
          return planWithMiss;
        },
      };
      const friction: { cardId: string; kind: string; detail: string }[] = [];
      const decomposer = new EpicDecomposer(
        client, approvals, port, () => 1_000, {},
        {
          language: { judge, model: "jev-latest", threshold: 0.75 },
          recordFriction: async (input) => { friction.push(input); },
        },
      );

      const outcome = await decomposer.decompose(epic());

      // Both attempts produced the same plan, so it ends where an unfixable
      // plan ends; what matters is that the second attempt was told why.
      expect(outcome).toMatchObject({ kind: "rejected" });
      expect(requests[1]!.previousRejections.join(" ")).toContain("describes how the system is built");
      expect(await state()).toBe("BLOCKED");
      // Once per attempt: the table missed the same line twice, and that is
      // two misses, not one.
      expect(friction).toMatchObject([
        { cardId: "M2", kind: "decompose_language_judged" },
        { cardId: "M2", kind: "decompose_language_judged" },
      ]);
      expect(friction[0]!.detail).toContain("0.96");
    });

    it("presents the plan the judge had no objection to", async () => {
      const judge = judgeStub(() => 0.03);
      const port = { run: vi.fn(async () => plan) };
      const decomposer = new EpicDecomposer(
        client, approvals, port, () => 1_000, {},
        { language: { judge, model: "jev-latest", threshold: 0.75 } },
      );

      await expect(decomposer.decompose(epic())).resolves.toMatchObject({ kind: "presented" });
      // Every line a person will read was put to it, and none of them twice.
      const sentences = judge.asked.map((request) => (request.state as { sentence: string }).sentence);
      expect(new Set(sentences).size).toBe(sentences.length);
      expect(sentences).toContain(plan.businessGoal);
      expect(sentences).toContain(plan.stories[0]!.scenarios[0]!.then);
    });

    it("refuses a Story the slice judge reads as a step the team takes", async () => {
      // The non-empty checks cannot see this: "费用数据的存放位置" is a
      // present, distinct entry point, so six Stories cut this way pass every
      // check and none of them can be delivered on its own.
      const layered: DecompositionCandidate = {
        ...plan,
        stories: [{
          ...plan.stories[0]!,
          title: "费用数据的存储结构",
          userEntryPoint: "费用数据的存放位置",
          verificationPath: "确认数据能按四个维度取出",
        }],
      };
      const sliceJudge: SystemOne = {
        async ask() {
          return { answers: { is_partial_slice: { type: "noul", noul: 0.91 } } };
        },
      };
      const requests: DecomposeRequest[] = [];
      const port = {
        run: async (input: DecomposeRequest) => {
          requests.push(input);
          return layered;
        },
      };
      const friction: { cardId: string; kind: string; detail: string }[] = [];
      const decomposer = new EpicDecomposer(
        client, approvals, port, () => 1_000, {},
        {
          slice: { judge: sliceJudge, model: "jev-latest", threshold: 0.6 },
          recordFriction: async (input) => { friction.push(input); },
        },
      );

      await expect(decomposer.decompose(epic())).resolves.toMatchObject({ kind: "rejected" });
      expect(requests[1]!.previousRejections.join(" ")).toContain("Re-split the Epic");
      expect(friction[0]).toMatchObject({ cardId: "M2", kind: "decompose_slice_judged" });
    });

    it("presents the same plan as today when there is no judge", async () => {
      // The whole point of the floor: an unreachable judge subtracts nothing.
      const port = { run: vi.fn(async () => planWithMiss) };
      const decomposer = new EpicDecomposer(client, approvals, port, () => 1_000);

      await expect(decomposer.decompose(epic())).resolves.toMatchObject({ kind: "presented" });
    });
  });

  it("tells the next split what the person said was wrong with the last one", async () => {
    // Without this the retry is blind: the same requirement produces the same
    // plan, and the person who said what was wrong watches it come back.
    await approvals.present({ epicId: "M2", notionPageId: "epic-page", title: "Plan", plan });
    await approvals.requestRevision("M2", "comment-1", "第二张卡应该拆成两张");
    const requests: DecomposeRequest[] = [];
    const port = {
      run: async (input: DecomposeRequest) => {
        requests.push(input);
        return plan;
      },
    };

    await new EpicDecomposer(client, approvals, port, () => 1_000).decompose(epic());

    expect(requests[0]!.requirement).toContain("第二张卡应该拆成两张");
    expect(requests[0]!.requirement).toContain("上一版拆解方案被退回");
    // The page's own words are still the head of it.
    expect(requests[0]!.requirement.startsWith(epic().requirement)).toBe(true);
  });

  it("does not block an Epic for using the words its own requirement used", async () => {
    // Before this the word table refused the Story, both attempts produced the
    // same refusal because the word *is* the requirement, and a correctly
    // written Epic stopped and waited for a person.
    const technicalEpic = {
      ...epic(),
      requirement: "合作方的技术同学可以调用我们的 API 自助查询订单状态，不用再发邮件问我们。",
    };
    const technicalPlan: DecompositionCandidate = {
      ...plan,
      businessGoal: "合作方自己就能查到订单状态。",
      stories: [{
        ...plan.stories[0]!,
        title: "合作方自助查询订单状态",
        requirement: "合作方按示例调用 API，拿到这一单当前的状态。",
        userEntryPoint: "开放平台的「订单查询」页",
        verificationPath: "用一个合作方账号查一单，确认状态和后台一致",
        scenarios: [{ id: "S-M2-01-a", given: "合作方有订单号", when: "他调用 API", then: "他拿到当前状态" }],
      }],
    };

    await expect(new EpicDecomposer(client, approvals, { run: async () => technicalPlan }, () => 1_000)
      .decompose(technicalEpic)).resolves.toMatchObject({ kind: "presented" });
  });

  it("starts the work itself when nobody reviews how it was split", async () => {
    const port = { run: vi.fn(async () => plan) };
    const decomposer = new EpicDecomposer(client, new PlanApprovalStore(client, () => 1_000), port, () => 1_000);

    await expect(decomposer.decompose(epic())).resolves.toMatchObject({ kind: "presented" });
    expect(await state()).toBe("EXECUTING");
    // The page still says how the work was cut; nobody is asked to confirm it.
    const outbox = (await client.execute("SELECT operation FROM notion_outbox ORDER BY id")).rows;
    expect(outbox.map((row) => row.operation)).toContain("present_epic_plan");
    expect((await client.execute("SELECT state FROM execution_dispatches")).rows).toEqual([{ state: "pending" }]);
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
