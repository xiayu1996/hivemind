import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PendingTodoDetail, PendingTodoSummary } from "../orchestrator/pending-todo.js";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import type { ConsoleTodoReadPort } from "./todo-contract.js";

/**
 * The todo page's first paint.
 *
 * The screen fetches its todo on mount, so between the document loading and
 * that read returning the page shows only the loading placeholder. A browser
 * round snapshots a freshly opened page right after load, which means it races
 * the read and can record the placeholder instead of the todo. Putting the
 * waiting todo in the served document removes that race; leaving an empty
 * ledger to the page's own read keeps the loading state observable.
 */

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

const emptyRead: ConsoleTodoReadPort = {
  listTodos: async () => ({ todos: [], openTodoId: null }),
  readTodo: async () => null,
};

/** A built shell with one index the console can serve, cleaned up by the test. */
function uiShell(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "console-ui-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><html><body><div id=\"app\"></div></body></html>", "utf8");
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("the todo page's first paint", () => {
  it("@scenario S-R237511TD-02-stable carries the waiting todo in the served document", async () => {
    const shell = uiShell();
    const app = await createConsoleServer(data, { uiRoot: shell.root, serveUi: true, todoRead });

    const response = await app.inject({ method: "GET", url: "/todos?scenario=S-R237511TD-02-stable" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('id="hivemind-initial-todo"');
    expect(response.body).toContain(TODO_ID);
    expect(response.body).toContain("要不要先发提醒？");
    await app.close();
    shell.dispose();
  });

  it("@scenario S-R237511TD-01-loading leaves an empty ledger to the page's own read", async () => {
    const shell = uiShell();
    const app = await createConsoleServer(data, { uiRoot: shell.root, serveUi: true, todoRead: emptyRead });

    const response = await app.inject({ method: "GET", url: "/todos?scenario=S-R237511TD-01-loading" });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('id="hivemind-initial-todo"');
    await app.close();
    shell.dispose();
  });
});
