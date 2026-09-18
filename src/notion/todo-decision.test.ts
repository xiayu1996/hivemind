import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { createTodoDecisionStore } from "../orchestrator/todo-decision.js";
import type { NotionGateway, NotionRequest } from "./gateway.js";
import { NotionOutbox, type NotionOutboxRecord } from "./outbox.js";
import { createTodoDecisionDelivery } from "./todo-decision-delivery.js";
import { recordConfirmedTodoDecisions, todoDecisionCommentId } from "./todo-decision-record.js";

type Comment = { body: string; mirror: boolean };

function write(comments: Comment[], pageId = "page-req"): NotionOutboxRecord {
  return {
    id: 7,
    cardId: null,
    priority: 0,
    operation: "record_todo_decision",
    target: pageId,
    payload: { todoId: "approve:requirement:R-1:prd", pageId, comments },
    payloadHash: "h".repeat(64),
    attempts: 1,
  };
}

async function seedDraftPrd(client: Client): Promise<void> {
  await client.execute({
    sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
          VALUES ('R-1', 'page-req', '控制台', 'PRD_CONFIRM', '原文', 1000, 1000)`,
  });
  await client.execute({
    sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at)
          VALUES ('R-1', 1, ?, 'draft', 2000)`,
    args: [JSON.stringify({ businessGoal: "值班的人随时知道卡在哪", nonGoals: [], scenarios: [], openQuestions: [] })],
  });
}

let client: Client;
let outbox: NotionOutbox;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  outbox = new NotionOutbox(client, () => 9_000);
});

afterEach(() => client.close());

describe("posting the decision onto the Notion entry", () => {
  it("@scenario S-R237511TD-01-approve posts each comment that is not on the page yet, in order", async () => {
    const page: string[] = [];
    const requests: NotionRequest[] = [];
    const gateway = {
      request: async (request: NotionRequest) => {
        requests.push(request);
        const body = request.body as { parent: { page_id: string }; rich_text: { text: { content: string } }[] };
        page.push(body.rich_text.map((part) => part.text.content).join(""));
        return { status: 200, data: { id: `c-${page.length}` } };
      },
    } as unknown as NotionGateway;
    const delivery = createTodoDecisionDelivery({ gateway, listComments: async () => page });

    const item = write([{ body: "批准", mirror: true }, { body: "这次先这样", mirror: false }]);
    await expect(delivery.missing(item)).resolves.toEqual(["批准", "这次先这样"]);

    await delivery.send(item);

    expect(page).toEqual(["批准", "这次先这样"]);
    expect(requests.map((request) => request.path)).toEqual(["/v1/comments", "/v1/comments"]);
    const first = requests[0]?.body as { parent: { page_id: string } } | undefined;
    expect(first?.parent.page_id).toBe("page-req");
    await expect(delivery.isApplied(item)).resolves.toBe(true);
  });

  it("treats a comment the page already carries as posted and only sends the rest", async () => {
    const page: string[] = ["批准"];
    const requests: NotionRequest[] = [];
    const gateway = {
      request: async (request: NotionRequest) => {
        requests.push(request);
        const body = request.body as { rich_text: { text: { content: string } }[] };
        page.push(body.rich_text.map((part) => part.text.content).join(""));
        return { status: 200, data: { id: "c-1" } };
      },
    } as unknown as NotionGateway;
    const delivery = createTodoDecisionDelivery({ gateway, listComments: async () => page });
    const item = write([{ body: "批准", mirror: true }, { body: "这次先这样", mirror: false }]);

    await expect(delivery.missing(item)).resolves.toEqual(["这次先这样"]);
    await expect(delivery.isApplied(item)).resolves.toBe(false);

    await delivery.send(item);

    expect(page).toEqual(["批准", "这次先这样"]);
    expect(requests).toHaveLength(1);
    await expect(delivery.isApplied(item)).resolves.toBe(true);
  });
});

describe("recording what Notion confirmed", () => {
  async function submitApproval(note = ""): Promise<number> {
    await seedDraftPrd(client);
    await createTodoDecisionStore({ client, outbox, now: () => 9_000 }).submit("approve:requirement:R-1:prd", {
      kind: "approve",
      conclusion: "approve",
      note,
      submittedBy: "本人",
    });
    return Number((await client.execute("SELECT id FROM notion_outbox")).rows[0]?.id);
  }

  it("names a mirrored comment by its outbox row", () => {
    expect(todoDecisionCommentId(3, 1)).toBe("todo-decision:3:1");
  });

  it("@scenario S-R237511TD-01-approve writes the confirmed word as the person's own comment on the entry", async () => {
    const outboxId = await submitApproval();
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 9000 WHERE id = ?", args: [outboxId] });

    const result = await recordConfirmedTodoDecisions(client, { now: () => 9_000 });

    expect(result).toMatchObject({ recorded: 1, failed: 0 });
    const mirrored = (await client.execute(
      "SELECT * FROM ingested_comments WHERE comment_id = ?",
      [todoDecisionCommentId(outboxId, 0)],
    )).rows[0];
    expect(mirrored).toMatchObject({
      page_id: "page-req",
      author: "本人",
      body: "批准",
      created_time: 9_000,
      ingested_at: 9_000,
    });
    expect((await client.execute("SELECT recorded_at FROM todo_decisions")).rows[0]?.recorded_at).toBe(9_000);
  });

  it("records the note nowhere: only the person's conclusion is their input", async () => {
    const outboxId = await submitApproval("这次先这样");
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 9000 WHERE id = ?", args: [outboxId] });

    await recordConfirmedTodoDecisions(client, { now: () => 9_000 });

    const bodies = (await client.execute("SELECT body FROM ingested_comments")).rows.map((row) => String(row.body));
    expect(bodies).toEqual(["批准"]);
  });

  it("does not record the same decision twice", async () => {
    const outboxId = await submitApproval();
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 9000 WHERE id = ?", args: [outboxId] });

    await recordConfirmedTodoDecisions(client, { now: () => 9_000 });
    const second = await recordConfirmedTodoDecisions(client, { now: () => 9_500 });

    expect(second).toMatchObject({ recorded: 0 });
    expect((await client.execute("SELECT COUNT(*) AS n FROM ingested_comments")).rows[0]?.n).toBe(1);
  });

  it("leaves a decision alone until Notion has confirmed the write", async () => {
    await submitApproval();

    const result = await recordConfirmedTodoDecisions(client, { now: () => 9_000 });

    expect(result).toMatchObject({ recorded: 0, failed: 0 });
    expect((await client.execute("SELECT COUNT(*) AS n FROM ingested_comments")).rows[0]?.n).toBe(0);
    expect((await client.execute("SELECT recorded_at FROM todo_decisions")).rows[0]?.recorded_at).toBeNull();
  });
});

describe("re-queueing a write that gave up", () => {
  async function enqueue(state: string): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, state, attempts, last_error, created_at)
            VALUES (NULL, 0, 'record_todo_decision', 'page-req', '{}', ?, ?, 3, 'notion 503', 1000)`,
      args: [`hash-${state}`, state],
    });
    return Number(result.lastInsertRowid);
  }

  it("puts a dead row back in the queue with a fresh budget", async () => {
    const id = await enqueue("dead");

    await expect(outbox.requeue(id)).resolves.toBe(true);

    const row = (await client.execute("SELECT state, attempts, last_error FROM notion_outbox WHERE id = ?", [id])).rows[0];
    expect(row).toMatchObject({ state: "pending", attempts: 0, last_error: null });
  });

  it("leaves a queued or already sent row alone", async () => {
    const pending = await enqueue("pending");
    const sent = await enqueue("sent");

    await expect(outbox.requeue(pending)).resolves.toBe(false);
    await expect(outbox.requeue(sent)).resolves.toBe(false);

    expect((await client.execute("SELECT state FROM notion_outbox WHERE id = ?", [sent])).rows[0]?.state).toBe("sent");
  });
});
