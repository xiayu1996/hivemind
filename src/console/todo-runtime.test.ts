import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type NotionOutboxDelivery, type NotionOutboxRecord } from "../notion/outbox.js";
import { migrate } from "../persistence/migrate.js";
import { type ConsoleDataSource } from "./server.js";
import { todoDecisionPath, todoDetailPath, todoSaveCheckPath } from "./todo-contract.js";
import { createTodoConsoleRuntime } from "./todo-runtime.js";

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({ ok: true }),
  providers: async () => [],
  queue: async () => ({ waiting: [], running: [] }),
};

async function seedAnswer(client: Client, storyId = "S-RUNTIME-01", questionKey = "q1"): Promise<string> {
  await client.execute({
    sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at)
          VALUES (?, ?, '确认提醒时间', '待办处理', 'NEEDS_INPUT', 'blocking_question', 1000, 1000)`,
    args: [storyId, `page-${storyId}`],
  });
  await client.execute({
    sql: `INSERT INTO open_questions (card_id, question_key, question, suggestion, blocking, created_at)
          VALUES (?, ?, '提醒应在什么时候发送？', '每天上午九点', 1, 1500)`,
    args: [storyId, questionKey],
  });
  return `answer:${storyId}:${questionKey}`;
}

async function seedApproval(client: Client, requirementId = "R-RUNTIME"): Promise<string> {
  await client.execute({
    sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
          VALUES (?, ?, '待办处理', 'PRD_CONFIRM', '原文', 1000, 1000)`,
    args: [requirementId, `page-${requirementId}`],
  });
  await client.execute({
    sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at)
          VALUES (?, 1, ?, 'draft', 2000)`,
    args: [requirementId, JSON.stringify({
      businessGoal: "让本人处理已有待办",
      nonGoals: [],
      scenarios: [],
      openQuestions: [],
    })],
  });
  return `approve:requirement:${requirementId}:prd`;
}

async function seedChoice(client: Client, requirementId = "R-CHOICE"): Promise<string> {
  await client.execute({
    sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
          VALUES (?, ?, '入口位置', 'CLARIFY', '原文', 1000, 1000)`,
    args: [requirementId, `page-${requirementId}`],
  });
  await client.execute({
    sql: `INSERT INTO requirement_clarify_rounds (requirement_id, round, questions, asked_at)
          VALUES (?, 1, ?, 3000)`,
    args: [requirementId, JSON.stringify([{
      question: "待办入口应放在哪里？",
      context: "决定本人从哪里进入。",
      options: [{ label: "运行总览顶部" }, { label: "独立导航", recommended: true }],
    }])],
  });
  return `choose:${requirementId}:1`;
}

describe("the todo surface used by a running console", () => {
  let client: Client;
  let failDelivery: Error | null;
  let sent: NotionOutboxRecord[];

  const delivery = (): NotionOutboxDelivery => ({
    isApplied: async () => false,
    send: async (record) => {
      if (failDelivery) throw failDelivery;
      sent.push(record);
    },
  });

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    failDelivery = null;
    sent = [];
  });

  afterEach(() => client.close());

  it("@scenario S-R237511TD-01-open serves an existing approval with its content, target and two unselected conclusions", async () => {
    const todoId = await seedApproval(client);
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });

    const found = await app.inject({ method: "GET", url: todoDetailPath(todoId) });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      todoId,
      kind: "approve",
      waitingSince: 2000,
      subject: { kind: "requirement", id: "R-RUNTIME", title: "待办处理" },
      notionTarget: { kind: "requirement", id: "R-RUNTIME" },
      conclusions: [
        { id: "approve", recommended: false },
        { id: "rework", recommended: false },
      ],
    });
    expect(found.json().sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "prd_goal", text: "让本人处理已有待办" }),
    ]));

    const missing = await app.inject({ method: "GET", url: todoDetailPath("approve:requirement:missing:prd") });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("@scenario S-R237511TD-01-answer accepts one non-empty answer, confirms it, and refuses an empty answer without another write", async () => {
    const todoId = await seedAnswer(client);
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });

    const empty = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "answer", answer: "  ", submittedBy: "本人" },
    });
    expect(empty.statusCode).toBe(422);
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(0);

    const accepted = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "answer", answer: "每天上午九点", submittedBy: "本人" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ ok: true, state: { status: "processed", recordedAt: 9000 } });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]?.payload))).toMatchObject({ comments: [{ body: "q1: 每天上午九点", mirror: true }] });
    expect((await app.inject({ method: "GET", url: "/api/todos" })).json()).toEqual({ todos: [], openTodoId: null });
    await app.close();
  });

  it("@scenario S-R237511TD-01-approve accepts only one of the two conclusions and confirms the accepted wording", async () => {
    const todoId = await seedApproval(client);
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });

    const invalid = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "approve", conclusion: "", note: "", submittedBy: "本人" },
    });
    expect(invalid.statusCode).toBe(422);

    const accepted = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "approve", conclusion: "approve", note: "", submittedBy: "本人" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ ok: true, state: { status: "processed" } });
    expect(JSON.parse(String(sent[0]?.payload))).toMatchObject({ comments: [{ body: "批准", mirror: true }] });
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(1);
    await app.close();
  });

  it("@scenario S-R237511TD-01-choose accepts a listed result, confirms it, and refuses a result the todo did not offer", async () => {
    const todoId = await seedChoice(client);
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });

    const invalid = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "choose", answers: [{ questionIndex: 1, optionLetter: "Z", text: "" }], note: "", submittedBy: "本人" },
    });
    expect(invalid.statusCode).toBe(422);

    const accepted = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "choose", answers: [{ questionIndex: 1, optionLetter: "B", text: "" }], note: "", submittedBy: "本人" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ ok: true, state: { status: "processed" } });
    expect(JSON.parse(String(sent[0]?.payload)).comments[0]).toMatchObject({ mirror: true });
    expect(JSON.parse(String(sent[0]?.payload)).comments[0].body).toContain("1B");
    await app.close();
  });

  it("@scenario S-R237511TD-01-savefail keeps the exact decision waiting and rechecks it until Notion confirms", async () => {
    const todoId = await seedAnswer(client, "S-RUNTIME-SAVE");
    failDelivery = new Error("notion 503");
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });

    const submitted = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "answer", answer: "每天上午九点", submittedBy: "本人" },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ ok: true, state: { status: "awaiting_notion" } });
    const before = String((await client.execute("SELECT comments FROM todo_decisions WHERE todo_id = ?", [todoId])).rows[0]?.comments);
    expect((await app.inject({ method: "GET", url: "/api/todos" })).json()).toMatchObject({
      todos: [{ todoId, decision: { status: "awaiting_notion", submittedAt: 9000 } }],
      openTodoId: todoId,
    });

    const stillWaiting = await app.inject({ method: "POST", url: todoSaveCheckPath(todoId), payload: {} });
    expect(stillWaiting.json()).toMatchObject({ ok: true, state: { status: "awaiting_notion" } });
    expect(String((await client.execute("SELECT comments FROM todo_decisions WHERE todo_id = ?", [todoId])).rows[0]?.comments)).toBe(before);

    failDelivery = null;
    const confirmed = await app.inject({ method: "POST", url: todoSaveCheckPath(todoId), payload: {} });
    expect(confirmed.json()).toMatchObject({ ok: true, state: { status: "processed", recordedAt: 9000 } });
    expect((await app.inject({ method: "GET", url: "/api/todos" })).json()).toEqual({ todos: [], openTodoId: null });
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(1);
    await app.close();
  });

  it("@scenario S-R237511TD-01-open returns not found for a todo the ledger never held", async () => {
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });

    const missing = await app.inject({ method: "GET", url: todoDetailPath("approve:requirement:missing:prd") });

    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("@scenario S-R237511TD-01-answer refuses a blank answer without recording or sending it", async () => {
    const todoId = await seedAnswer(client);
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });

    const response = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "answer", answer: "  ", submittedBy: "本人" },
    });

    expect(response.statusCode).toBe(422);
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(0);
    expect(sent).toEqual([]);
    await app.close();
  });

  it("@scenario S-R237511TD-01-approve refuses a conclusion outside approve and rework", async () => {
    const todoId = await seedApproval(client);
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });

    const response = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "approve", conclusion: "", note: "", submittedBy: "本人" },
    });

    expect(response.statusCode).toBe(422);
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(0);
    await app.close();
  });

  it("@scenario S-R237511TD-01-choose refuses an option the todo did not offer", async () => {
    const todoId = await seedChoice(client);
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });

    const response = await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "choose", answers: [{ questionIndex: 1, optionLetter: "Z", text: "" }], note: "", submittedBy: "本人" },
    });

    expect(response.statusCode).toBe(422);
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(0);
    await app.close();
  });

  it("@scenario S-R237511TD-01-savefail rechecks the stored decision without creating a second one", async () => {
    const todoId = await seedAnswer(client, "S-RUNTIME-RECHECK");
    failDelivery = new Error("notion 503");
    const app = await createTodoConsoleRuntime(data, { client, delivery: delivery(), now: () => 9000, server: { serveUi: false } });
    await app.inject({
      method: "POST",
      url: todoDecisionPath(todoId),
      payload: { kind: "answer", answer: "每天上午九点", submittedBy: "本人" },
    });
    const before = String((await client.execute("SELECT comments FROM todo_decisions WHERE todo_id = ?", [todoId])).rows[0]?.comments);

    const response = await app.inject({ method: "POST", url: todoSaveCheckPath(todoId), payload: {} });

    expect(response.json()).toMatchObject({ ok: true, state: { status: "awaiting_notion" } });
    expect(String((await client.execute("SELECT comments FROM todo_decisions WHERE todo_id = ?", [todoId])).rows[0]?.comments)).toBe(before);
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(1);
    await app.close();
  });
});
