import { describe, expect, it } from "vitest";
import type { PendingTodoDetail, PendingTodoSummary } from "../orchestrator/pending-todo.js";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import {
  todoDecisionPath,
  todoDetailPath,
  todoSaveCheckPath,
  type ConsoleTodoCommandPort,
  type ConsoleTodoReadPort,
} from "./todo-contract.js";

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({ ok: true }),
  providers: async () => [],
  queue: async () => ({ waiting: [], running: [] }),
};

const TODO_ID = "answer:S-EPIC1-01:q1";

const subject = {
  kind: "story" as const,
  id: "S-EPIC1-01",
  title: "回答一件事",
  pageId: "page-story",
  pageUrl: "https://notion.so/page-story",
  requirementId: null,
  requirementTitle: null,
};

const summary: PendingTodoSummary = {
  todoId: TODO_ID,
  kind: "answer",
  title: "要不要先发提醒？",
  subject,
  waitingSince: 1_500,
  decision: null,
};

const detail: PendingTodoDetail = {
  ...summary,
  sections: [],
  questions: [{ index: 1, question: "要不要先发提醒？", context: null, suggestion: "先不发", options: [] }],
  conclusions: [],
  notionTarget: subject,
};

const todoRead: ConsoleTodoReadPort = {
  listTodos: async () => ({ todos: [summary], openTodoId: TODO_ID }),
  readTodo: async (todoId) => (todoId === TODO_ID ? detail : null),
};

const todoCommands: ConsoleTodoCommandPort = {
  submit: async (todoId, submission) => {
    if (todoId !== TODO_ID) return { kind: "gone" };
    if (submission.kind === "answer" && submission.answer.trim() === "") {
      return { kind: "invalid", issues: ["empty_answer"] };
    }
    return { kind: "accepted", state: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 } };
  },
  recheck: async () => ({ status: "processed", submittedAt: 9_000, recordedAt: 9_500 }),
};

/** `null` means "leave this port unwired", which is what the read-only case needs. */
async function consoleApp(override: { todoRead?: ConsoleTodoReadPort | null; todoCommands?: ConsoleTodoCommandPort | null } = {}): Promise<Awaited<ReturnType<typeof createConsoleServer>>> {
  const options: Parameters<typeof createConsoleServer>[1] = { serveUi: false };
  const read = override.todoRead === undefined ? todoRead : override.todoRead;
  const commands = override.todoCommands === undefined ? todoCommands : override.todoCommands;
  if (read !== null) options.todoRead = read;
  if (commands !== null) options.todoCommands = commands;
  return createConsoleServer(data, options);
}

describe("the todo reads", () => {
  it("@scenario S-R237511TD-01-open lists what waits and names the todo the page opens on", async () => {
    const app = await consoleApp();

    const response = await app.inject({ method: "GET", url: "/api/todos" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ todos: [summary], openTodoId: TODO_ID });
    await app.close();
  });

  it("@scenario S-R237511TD-01-existing answers an empty ledger with an empty list, not an error", async () => {
    const app = await consoleApp({ todoRead: { listTodos: async () => ({ todos: [], openTodoId: null }), readTodo: async () => null } });

    const response = await app.inject({ method: "GET", url: "/api/todos" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ todos: [], openTodoId: null });
    await app.close();
  });

  it("serves one todo, and answers 404 for an id that is not one", async () => {
    const app = await consoleApp();

    const found = await app.inject({ method: "GET", url: todoDetailPath(TODO_ID) });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ todoId: TODO_ID, kind: "answer", notionTarget: { pageId: "page-story" } });

    const missing = await app.inject({ method: "GET", url: todoDetailPath("answer:S-1:nope") });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe("the todo writes", () => {
  it("@scenario S-R237511TD-01-answer accepts a decision and answers with the state that follows", async () => {
    const app = await consoleApp();

    const response = await app.inject({
      method: "POST",
      url: todoDecisionPath(TODO_ID),
      payload: { kind: "answer", answer: "先不发", submittedBy: "本人" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, state: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 } });
    await app.close();
  });

  it("answers 422 with the validation codes and 404 for a todo that is gone", async () => {
    const app = await consoleApp();

    const invalid = await app.inject({
      method: "POST",
      url: todoDecisionPath(TODO_ID),
      payload: { kind: "answer", answer: "  ", submittedBy: "本人" },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toEqual({ ok: false, reason: "invalid", issues: ["empty_answer"] });

    const gone = await app.inject({
      method: "POST",
      url: todoDecisionPath("answer:S-1:nope"),
      payload: { kind: "answer", answer: "先不发", submittedBy: "本人" },
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ ok: false, reason: "gone" });
    await app.close();
  });

  it("re-checks a save and answers where the decision stands", async () => {
    const app = await consoleApp();

    const response = await app.inject({ method: "POST", url: todoSaveCheckPath(TODO_ID), payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, state: { status: "processed", submittedAt: 9_000, recordedAt: 9_500 } });
    await app.close();
  });

  it("serves the todo page read-only when no command port is wired", async () => {
    const app = await consoleApp({ todoCommands: null });

    await expect(app.inject({ method: "GET", url: "/api/todos" })).resolves.toMatchObject({ statusCode: 200 });
    const refused = await app.inject({
      method: "POST",
      url: todoDecisionPath(TODO_ID),
      payload: { kind: "answer", answer: "先不发", submittedBy: "本人" },
    });
    expect(refused.statusCode).toBe(405);
    await app.close();
  });
});

describe("every other write is refused before a handler", () => {
  it("@scenario S-R237511TD-01-existing refuses creating, editing and advancing work", async () => {
    const app = await consoleApp();

    const created = await app.inject({ method: "POST", url: "/api/todos", payload: { title: "新需求" } });
    const edited = await app.inject({ method: "POST", url: todoDetailPath(TODO_ID), payload: { title: "改标题" } });
    const requirement = await app.inject({ method: "POST", url: "/api/requirements", payload: { title: "新需求" } });
    const advanced = await app.inject({ method: "POST", url: "/api/stories/S-EPIC1-01/advance", payload: {} });
    const removed = await app.inject({ method: "DELETE", url: todoDetailPath(TODO_ID) });

    for (const response of [created, edited, requirement, advanced, removed]) expect(response.statusCode).toBe(405);
    await app.close();
  });

  it("still serves the reads that were there before", async () => {
    const app = await consoleApp();

    await expect(app.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "GET", url: "/api/queue" })).resolves.toMatchObject({ statusCode: 200 });
    await app.close();
  });
});
