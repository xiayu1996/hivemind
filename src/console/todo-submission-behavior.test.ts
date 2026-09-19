import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "../notion/outbox.js";
import { migrate } from "../persistence/migrate.js";
import {
  TODO_COPY,
  formatProcessedLine,
  initialTodoView,
  reduceTodoView,
  type TodoDetailDto,
  type TodoSubmissionDto,
  type TodoViewState,
} from "../../console-ui/src/pages/todo/contracts.js";
import * as submissionContract from "../../console-ui/src/pages/todo/submission-contract.js";
import { createTodoConsoleRuntime } from "./todo-runtime.js";
import { todoDecisionPath } from "./todo-contract.js";
import type { ConsoleDataSource } from "./server.js";

const TODO_ID = "answer:S-R237-ANSWER:q1";
const ANSWER = "每天早上 9 点发一次";

const answerTodo: TodoDetailDto = {
  todoId: TODO_ID,
  kind: "answer",
  title: "提醒应在什么时候发送？",
  subject: {
    kind: "story",
    id: "S-R237-ANSWER",
    title: "确认提醒时间",
    pageId: "page-S-R237-ANSWER",
    pageUrl: "https://www.notion.so/page-S-R237-ANSWER",
    requirementId: null,
    requirementTitle: null,
  },
  waitingSince: 1_000,
  decision: null,
  sections: [],
  questions: [{
    index: 1,
    question: "提醒应在什么时候发送？",
    context: null,
    suggestion: "每天上午九点",
    options: [],
  }],
  conclusions: [],
  notionTarget: {
    kind: "story",
    id: "S-R237-ANSWER",
    title: "确认提醒时间",
    pageId: "page-S-R237-ANSWER",
    pageUrl: "https://www.notion.so/page-S-R237-ANSWER",
  },
};

const submission: TodoSubmissionDto = { kind: "answer", answer: ANSWER, submittedBy: "本人" };

function ready(todo: TodoDetailDto = answerTodo): TodoViewState {
  const loading = reduceTodoView(initialTodoView(todo.todoId), { type: "load", todoId: todo.todoId });
  return reduceTodoView(loading, {
    type: "loaded",
    requestId: loading.requestId,
    result: { kind: "pending", todo },
  });
}

function submitting(): TodoViewState {
  return reduceTodoView(ready(), { type: "submit", requestId: 2, submission });
}

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({ ok: true }),
  providers: async () => [],
  queue: async () => ({ waiting: [], running: [] }),
};

async function seedAnswer(client: Client): Promise<void> {
  await client.execute({
    sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at)
          VALUES ('S-R237-ANSWER', 'page-S-R237-ANSWER', '确认提醒时间', '待办处理', 'NEEDS_INPUT', 'blocking_question', 1000, 1000)`,
    args: [],
  });
  await client.execute({
    sql: `INSERT INTO open_questions (card_id, question_key, question, suggestion, blocking, created_at)
          VALUES ('S-R237-ANSWER', 'q1', '提醒应在什么时候发送？', '每天上午九点', 1, 1500)`,
    args: [],
  });
}

describe("a confirmed todo answer", () => {
  let client: Client;
  let sent: NotionOutboxRecord[];

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    await seedAnswer(client);
    sent = [];
  });

  afterEach(() => client.close());

  it("@scenario S-R237511TD-02-answer 确认保留后显示已处理并在对应任务留下原答复", async () => {
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async (record) => {
        sent.push(record);
      },
    };
    const app = await createTodoConsoleRuntime(data, {
      client,
      delivery,
      now: () => 9_000,
      server: { serveUi: false },
    });

    const response = await app.inject({
      method: "POST",
      url: todoDecisionPath(TODO_ID),
      payload: submission,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      state: { status: "processed", submittedAt: 9_000, recordedAt: 9_000 },
    });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]?.payload))).toEqual({
      todoId: TODO_ID,
      pageId: "page-S-R237-ANSWER",
      comments: [{ body: `q1: ${ANSWER}`, mirror: true }],
    });
    expect((await client.execute(
      "SELECT author, body FROM ingested_comments WHERE page_id = 'page-S-R237-ANSWER'",
    )).rows).toEqual([expect.objectContaining({ author: "本人", body: `q1: ${ANSWER}` })]);
    expect((await app.inject({ method: "GET", url: "/api/todos" })).json()).toEqual({
      todos: [],
      openTodoId: null,
    });
    expect(formatProcessedLine(answerTodo)).toBe("答复已保留到对应的 Notion 任务“确认提醒时间”。");
    await app.close();
  });

  it("@scenario S-R237511TD-02-answer 保留尚未确认时仍显示未处理且不显示空状态", async () => {
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async () => {
        throw new Error("Notion refused the write");
      },
    };
    const app = await createTodoConsoleRuntime(data, {
      client,
      delivery,
      now: () => 9_000,
      server: { serveUi: false },
    });

    const response = await app.inject({ method: "POST", url: todoDecisionPath(TODO_ID), payload: submission });
    const list = (await app.inject({ method: "GET", url: "/api/todos" })).json();

    expect(response.json()).toMatchObject({ ok: true, state: { status: "awaiting_notion" } });
    expect(list).toMatchObject({
      todos: [{ todoId: TODO_ID, decision: { status: "awaiting_notion" } }],
      openTodoId: TODO_ID,
    });
    expect(list.todos).toHaveLength(1);
    await app.close();
  });
});

describe("the page projection after an answer", () => {
  it("@scenario S-R237511TD-02-answer 只有确认保留的答复才投影为已处理", () => {
    expect(submissionContract.projectTodoSubmission).toBeTypeOf("function");
    const projection = submissionContract.projectTodoSubmission(answerTodo, submission, {
      kind: "recorded",
      state: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 },
    });

    expect(projection).toEqual({
      kind: "confirmed",
      todo: answerTodo,
      submission,
      decision: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 },
    });
  });

  it("@scenario S-R237511TD-02-answer 尚未确认保留的答复不得投影为已处理", () => {
    expect(submissionContract.projectTodoSubmission).toBeTypeOf("function");
    const projection = submissionContract.projectTodoSubmission(answerTodo, submission, {
      kind: "recorded",
      state: { status: "awaiting_notion", submittedAt: 9_000 },
    });

    expect(projection).toEqual({
      kind: "awaiting_confirmation",
      todo: answerTodo,
      submission,
      decision: { status: "awaiting_notion", submittedAt: 9_000 },
    });
    expect(projection.kind).not.toBe("confirmed");
  });
});

describe("a rejected todo answer", () => {
  it("@scenario S-R237511TD-02-rejected 提交被拒绝时保留待办和原答复并明确提示重试", () => {
    const state = reduceTodoView(submitting(), {
      type: "submitted",
      requestId: 2,
      result: { kind: "failed" },
    });

    expect(state.status).toBe("submission_rejected");
    expect(state.todo).toEqual(answerTodo);
    expect(state.submission).toEqual(submission);
    expect(state.decision).toBeNull();
    expect((TODO_COPY as unknown as Record<string, unknown>).answerNotSubmitted).toBe("答复未提交，请重试");
    expect(state.status).not.toBe("processed");
    expect(state.status).not.toBe("none");
  });

  it("@scenario S-R237511TD-02-rejected 提交期间待办消失也不得显示成已处理或所有事项已处理", () => {
    expect(submissionContract.projectTodoSubmission).toBeTypeOf("function");
    const projection = submissionContract.projectTodoSubmission(answerTodo, submission, { kind: "gone" });

    expect(projection).toEqual({
      kind: "submission_rejected",
      todo: answerTodo,
      submission,
      messageKey: "answer_not_submitted",
    });
    expect(projection.kind).not.toBe("confirmed");
  });
});
