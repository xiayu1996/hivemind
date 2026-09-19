import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NotionOutboxDelivery } from "../notion/outbox.js";
import { migrate } from "../persistence/migrate.js";
import { todoDetailPath } from "./todo-contract.js";
import { createVerificationConsole } from "./app-entry.js";

const delivery: NotionOutboxDelivery = {
  isApplied: async () => false,
  send: async () => undefined,
};

async function seedApproval(client: Client, requirementId = "R-ENTRY"): Promise<string> {
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

describe("the console an application under verification serves", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
  });

  afterEach(() => client.close());

  it("@scenario S-R237511TD-01-open serves the waiting list and one todo's content, not only the page that reads them", async () => {
    const todoId = await seedApproval(client);
    const app = await createVerificationConsole({
      client,
      delivery,
      uiRoot: "/nonexistent",
      serveUi: false,
      now: () => 9000,
    });

    const list = await app.inject({ method: "GET", url: "/api/todos" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ todos: [{ todoId, kind: "approve" }], openTodoId: todoId });

    const detail = await app.inject({ method: "GET", url: todoDetailPath(todoId) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      todoId,
      kind: "approve",
      subject: { id: "R-ENTRY" },
      conclusions: [{ id: "approve" }, { id: "rework" }],
    });
    await app.close();
  });
});
