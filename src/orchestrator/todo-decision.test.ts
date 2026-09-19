import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { NotionOutbox, type NotionOutboxDelivery, type NotionOutboxRecord } from "../notion/outbox.js";
import { listPendingTodos, readTodoDecisionState, type PendingTodoDetail } from "./pending-todo.js";
import {
  composeTodoDecisionComments,
  createTodoDecisionDrain,
  createTodoDecisionStore,
  type TodoDecisionStore,
  type TodoSubmission,
} from "./todo-decision.js";

function detail(overrides: Partial<PendingTodoDetail> = {}): PendingTodoDetail {
  return {
    todoId: "answer:S-EPIC1-01:q1",
    kind: "answer",
    title: "要不要先发提醒？",
    subject: {
      kind: "story",
      id: "S-EPIC1-01",
      title: "回答一件事",
      pageId: "page-story",
      pageUrl: "https://notion.so/page-story",
      requirementId: null,
      requirementTitle: null,
    },
    waitingSince: 1_500,
    decision: null,
    sections: [],
    questions: [{ index: 1, question: "要不要先发提醒？", context: null, suggestion: "先不发", options: [] }],
    conclusions: [],
    notionTarget: {
      kind: "story",
      id: "S-EPIC1-01",
      title: "回答一件事",
      pageId: "page-story",
      pageUrl: "https://notion.so/page-story",
    },
    ...overrides,
  };
}

const approveDetail = (): PendingTodoDetail => detail({
  todoId: "approve:requirement:R-1:prd",
  kind: "approve",
  title: "控制台",
  questions: [],
  conclusions: [
    { id: "approve", label: "", recommended: false },
    { id: "rework", label: "", recommended: false },
  ],
  subject: {
    kind: "requirement",
    id: "R-1",
    title: "控制台",
    pageId: "page-req",
    pageUrl: "https://notion.so/page-req",
    requirementId: "R-1",
    requirementTitle: "控制台",
  },
  notionTarget: {
    kind: "requirement",
    id: "R-1",
    title: "控制台",
    pageId: "page-req",
    pageUrl: "https://notion.so/page-req",
  },
});

const chooseDetail = (): PendingTodoDetail => detail({
  todoId: "choose:R-1:1",
  kind: "choose",
  title: "手机优先吗？",
  subject: {
    kind: "requirement",
    id: "R-1",
    title: "控制台",
    pageId: "page-req",
    pageUrl: "https://notion.so/page-req",
    requirementId: "R-1",
    requirementTitle: "控制台",
  },
  questions: [{
    index: 1,
    question: "手机优先吗？",
    context: null,
    suggestion: null,
    options: [{ id: "A", label: "先做手机端", recommended: false }, { id: "B", label: "先做桌面端", recommended: true }],
  }],
  notionTarget: {
    kind: "requirement",
    id: "R-1",
    title: "控制台",
    pageId: "page-req",
    pageUrl: "https://notion.so/page-req",
  },
});

async function seedStoryQuestion(client: Client, question = "要不要先发提醒？"): Promise<void> {
  await client.execute({
    sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at)
          VALUES ('S-EPIC1-01', 'page-story', '回答一件事', '原文', 'NEEDS_INPUT', 'blocking_question', 1000, 1000)`,
  });
  await client.execute({
    sql: `INSERT INTO open_questions (card_id, question_key, question, suggestion, blocking, created_at)
          VALUES ('S-EPIC1-01', 'q1', ?, '先不发', 1, 1500)`,
    args: [question],
  });
}

async function seedRequirementPrd(client: Client): Promise<void> {
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

async function seedRequirementClarify(client: Client): Promise<void> {
  await client.execute({
    sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
          VALUES ('R-1', 'page-req', '控制台', 'CLARIFY', '原文', 1000, 1000)`,
  });
  await client.execute({
    sql: `INSERT INTO requirement_clarify_rounds (requirement_id, round, questions, asked_at)
          VALUES ('R-1', 1, ?, 4000)`,
    args: [JSON.stringify([{
      question: "手机优先吗？",
      options: [{ label: "先做手机端" }, { label: "先做桌面端", recommended: true }],
    }])],
  });
}

/** The submission the page would send, with the id it must not invent. */
const submission = (input: unknown): TodoSubmission => input as TodoSubmission;

let client: Client;
let outbox: NotionOutbox;
let posted: number[];
let failDelivery: Error | null;

function delivery(): NotionOutboxDelivery {
  return {
    isApplied: async () => false,
    send: async (record: NotionOutboxRecord) => {
      if (failDelivery) throw failDelivery;
      posted.push(record.id);
    },
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
  outbox = new NotionOutbox(client, () => 9_000);
  posted = [];
  failDelivery = null;
});

afterEach(() => client.close());

const drainStore = (): TodoDecisionStore => createTodoDecisionStore({
  client,
  outbox,
  drain: createTodoDecisionDrain({ client, outbox, delivery: delivery(), now: () => 9_000 }),
  now: () => 9_000,
});

const plainStore = (): TodoDecisionStore => createTodoDecisionStore({ client, outbox, now: () => 9_000 });

describe("the words a decision writes", () => {
  it("answers a Story question as a keyed reply so the Story lane reads it", () => {
    const comments = composeTodoDecisionComments(
      detail(),
      { kind: "answer", answer: "先不发", submittedBy: "本人" },
    );

    expect(comments).toEqual([{ body: "q1: 先不发", mirror: true }]);
  });

  it("approves with the single word both lanes accept, and posts a note without recording it", () => {
    const comments = composeTodoDecisionComments(
      approveDetail(),
      { kind: "approve", conclusion: "approve", note: "这次先这样", submittedBy: "本人" },
    );

    expect(comments).toEqual([
      { body: "批准", mirror: true },
      { body: "这次先这样", mirror: false },
    ]);
  });

  it("approves without a note as exactly one recorded comment", () => {
    const comments = composeTodoDecisionComments(
      approveDetail(),
      { kind: "approve", conclusion: "approve", note: "", submittedBy: "本人" },
    );

    expect(comments).toEqual([{ body: "批准", mirror: true }]);
  });

  it("sends the rework note as the recorded conclusion", () => {
    const comments = composeTodoDecisionComments(
      approveDetail(),
      { kind: "approve", conclusion: "rework", note: "表格对齐再改一版", submittedBy: "本人" },
    );

    expect(comments).toEqual([{ body: "表格对齐再改一版", mirror: true }]);
  });

  it("rework without a note still says what it is", () => {
    const comments = composeTodoDecisionComments(
      approveDetail(),
      { kind: "approve", conclusion: "rework", note: "", submittedBy: "本人" },
    );

    expect(comments).toEqual([{ body: "要求返工", mirror: true }]);
  });

  it("writes a pick as the numbered letter form the clarification lane reads back", () => {
    const comments = composeTodoDecisionComments(
      chooseDetail(),
      { kind: "choose", answers: [{ questionIndex: 1, optionLetter: "B", text: "" }], note: "", submittedBy: "本人" },
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]?.mirror).toBe(true);
    expect(comments[0]?.body).toContain("1B");
  });
});

describe("submitting a decision", () => {
  it("records the decision and the write together, and reports waiting on Notion", async () => {
    await seedStoryQuestion(client);

    const outcome = await plainStore().submit("answer:S-EPIC1-01:q1", {
      kind: "answer",
      answer: "先不发",
      submittedBy: "本人",
    });

    expect(outcome).toEqual({ kind: "accepted", state: { status: "awaiting_notion", submittedAt: 9_000 } });

    const decision = (await client.execute("SELECT * FROM todo_decisions")).rows[0];
    expect(decision).toMatchObject({
      todo_id: "answer:S-EPIC1-01:q1",
      kind: "answer",
      subject_kind: "story",
      subject_id: "S-EPIC1-01",
      page_id: "page-story",
      submitted_by: "本人",
      submitted_at: 9_000,
      recorded_at: null,
    });

    const write = (await client.execute("SELECT * FROM notion_outbox")).rows[0];
    expect(write?.operation).toBe("record_todo_decision");
    expect(write?.target).toBe("page-story");
    expect(write?.state).toBe("pending");
    expect(JSON.parse(String(write?.payload))).toEqual({
      todoId: "answer:S-EPIC1-01:q1",
      pageId: "page-story",
      comments: [{ body: "q1: 先不发", mirror: true }],
    });
  });

  it("@scenario S-R237511TD-01-answer confirms, records and drops an answered Story from the waiting list", async () => {
    await seedStoryQuestion(client);

    const outcome = await drainStore().submit("answer:S-EPIC1-01:q1", {
      kind: "answer",
      answer: "先发一条提醒",
      submittedBy: "本人",
    });

    expect(outcome).toMatchObject({ kind: "accepted", state: { status: "processed" } });
    await expect(listPendingTodos(client)).resolves.toEqual([]);

    const mirrored = (await client.execute(
      "SELECT * FROM ingested_comments WHERE page_id = 'page-story'",
    )).rows[0];
    expect(mirrored).toMatchObject({
      page_id: "page-story",
      author: "本人",
      body: "q1: 先发一条提醒",
      created_time: 9_000,
    });
  });

  it("@scenario S-R237511TD-01-answer keeps the first decision when the same person submits twice", async () => {
    await seedStoryQuestion(client);
    const store = plainStore();

    const first = await store.submit("answer:S-EPIC1-01:q1", {
      kind: "answer",
      answer: "先不发",
      submittedBy: "本人",
    });
    const second = await store.submit("answer:S-EPIC1-01:q1", {
      kind: "answer",
      answer: "还是发吧",
      submittedBy: "本人",
    });

    expect(second).toEqual(first);
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(1);
    expect((await client.execute("SELECT COUNT(*) AS n FROM notion_outbox")).rows[0]?.n).toBe(1);
    const stored = (await client.execute("SELECT comments FROM todo_decisions")).rows[0];
    expect(String(stored?.comments)).toContain("先不发");
    expect(String(stored?.comments)).not.toContain("还是发吧");
  });

  it("@scenario S-R237511TD-01-approve records an approval whose conclusion is the single word both lanes accept", async () => {
    await seedRequirementPrd(client);

    const outcome = await plainStore().submit("approve:requirement:R-1:prd", {
      kind: "approve",
      conclusion: "approve",
      note: "",
      submittedBy: "本人",
    });

    expect(outcome).toMatchObject({ kind: "accepted" });
    const write = (await client.execute("SELECT payload, target FROM notion_outbox")).rows[0];
    expect(write?.target).toBe("page-req");
    expect(JSON.parse(String(write?.payload))).toEqual({
      todoId: "approve:requirement:R-1:prd",
      pageId: "page-req",
      comments: [{ body: "批准", mirror: true }],
    });
  });

  it("@scenario S-R237511TD-01-choose records a clarification pick as the numbered letter form", async () => {
    await seedRequirementClarify(client);

    const outcome = await plainStore().submit("choose:R-1:1", {
      kind: "choose",
      answers: [{ questionIndex: 1, optionLetter: "B", text: "" }],
      note: "",
      submittedBy: "本人",
    });

    expect(outcome).toMatchObject({ kind: "accepted" });
    const write = (await client.execute("SELECT payload FROM notion_outbox")).rows[0];
    const payload = JSON.parse(String(write?.payload)) as { comments: { body: string; mirror: boolean }[] };
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]?.mirror).toBe(true);
    expect(payload.comments[0]?.body).toContain("1B");
  });

  it("@scenario S-R237511TD-01-answer refuses an empty answer without writing anything", async () => {
    await seedStoryQuestion(client);

    const outcome = await plainStore().submit("answer:S-EPIC1-01:q1", {
      kind: "answer",
      answer: "   ",
      submittedBy: "本人",
    });

    expect(outcome).toEqual({ kind: "invalid", issues: ["empty_answer"] });
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(0);
    expect((await client.execute("SELECT COUNT(*) AS n FROM notion_outbox")).rows[0]?.n).toBe(0);
  });

  it("@scenario S-R237511TD-01-approve refuses an approval without one of the two conclusions", async () => {
    await seedRequirementPrd(client);

    const outcome = await plainStore().submit("approve:requirement:R-1:prd", submission({
      kind: "approve",
      conclusion: "maybe",
      note: "",
      submittedBy: "本人",
    }));

    expect(outcome).toEqual({ kind: "invalid", issues: ["unknown_conclusion"] });
  });

  it("@scenario S-R237511TD-01-choose refuses a choice that answers no question or picks an option that does not exist", async () => {
    await seedRequirementClarify(client);
    const store = plainStore();

    await expect(store.submit("choose:R-1:1", {
      kind: "choose",
      answers: [],
      note: "",
      submittedBy: "本人",
    })).resolves.toEqual({ kind: "invalid", issues: ["empty_choice"] });

    await expect(store.submit("choose:R-1:1", {
      kind: "choose",
      answers: [{ questionIndex: 1, optionLetter: "Z", text: "" }],
      note: "",
      submittedBy: "本人",
    })).resolves.toEqual({ kind: "invalid", issues: ["unknown_option"] });

    await expect(store.submit("choose:R-1:1", {
      kind: "choose",
      answers: [{ questionIndex: 9, optionLetter: "A", text: "" }],
      note: "",
      submittedBy: "本人",
    })).resolves.toEqual({ kind: "invalid", issues: ["unknown_question"] });
  });

  it("answers gone for an id that is not waiting and has no decision", async () => {
    await seedStoryQuestion(client);
    await client.execute("UPDATE stories SET state = 'CODE', stop_reason = NULL WHERE id = 'S-EPIC1-01'");
    const store = plainStore();

    await expect(store.submit("answer:S-EPIC1-01:q1", {
      kind: "answer",
      answer: "先不发",
      submittedBy: "本人",
    })).resolves.toEqual({ kind: "gone" });

    await expect(store.submit("answer:S-EPIC1-01:nope", {
      kind: "answer",
      answer: "先不发",
      submittedBy: "本人",
    })).resolves.toEqual({ kind: "gone" });

    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(0);
  });
});

describe("checking the save", () => {
  it("@scenario S-R237511TD-01-savefail reports still unhandled while Notion has not confirmed, and can be retried as it was", async () => {
    await seedStoryQuestion(client);
    failDelivery = new Error("notion 503");
    const store = drainStore();

    const submitted = await store.submit("answer:S-EPIC1-01:q1", {
      kind: "answer",
      answer: "先不发",
      submittedBy: "本人",
    });
    expect(submitted).toMatchObject({ kind: "accepted", state: { status: "awaiting_notion" } });

    const listed = await listPendingTodos(client);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.decision).toMatchObject({ status: "awaiting_notion" });
    expect(await store.recheck("answer:S-EPIC1-01:q1")).toMatchObject({ status: "awaiting_notion" });
    const stillStored = (await client.execute("SELECT comments FROM todo_decisions")).rows[0];
    expect(String(stillStored?.comments)).toContain("先不发");

    failDelivery = null;
    expect(await store.recheck("answer:S-EPIC1-01:q1")).toMatchObject({ status: "processed" });
    await expect(listPendingTodos(client)).resolves.toEqual([]);
    expect((await client.execute("SELECT recorded_at FROM todo_decisions")).rows[0]?.recorded_at).toBe(9_000);
  });

  it("@scenario S-R237511TD-01-savefail re-queues a write that gave up instead of replacing the decision", async () => {
    await seedStoryQuestion(client);
    failDelivery = new Error("notion 503");
    const cycle = createTodoDecisionDrain({ client, outbox, delivery: delivery(), now: () => 9_000 });
    const store = createTodoDecisionStore({ client, outbox, drain: cycle, now: () => 9_000 });
    await store.submit("answer:S-EPIC1-01:q1", { kind: "answer", answer: "先不发", submittedBy: "本人" });

    for (let attempt = 0; attempt < 7; attempt++) await cycle.drain();
    const gaveUp = await readTodoDecisionState(client, "answer:S-EPIC1-01:q1");
    expect(gaveUp).toMatchObject({ status: "retryable" });
    expect(gaveUp?.status === "retryable" ? gaveUp.detail : "").toContain("503");
    expect((await listPendingTodos(client))[0]?.decision).toMatchObject({ status: "retryable" });

    failDelivery = null;
    expect((await store.recheck("answer:S-EPIC1-01:q1"))?.status).not.toBe("retryable");
    expect(await store.recheck("answer:S-EPIC1-01:q1")).toMatchObject({ status: "processed" });
    expect((await client.execute("SELECT COUNT(*) AS n FROM todo_decisions")).rows[0]?.n).toBe(1);
  });

  it("returns null for a todo that has no decision at all", async () => {
    await seedStoryQuestion(client);
    await expect(plainStore().recheck("answer:S-EPIC1-01:q1")).resolves.toBeNull();
  });
});

describe("the drain", () => {
  it("delivers a queued decision and records it as the person's own input", async () => {
    await seedStoryQuestion(client);
    const store = plainStore();
    await store.submit("answer:S-EPIC1-01:q1", { kind: "answer", answer: "先不发", submittedBy: "本人" });

    await createTodoDecisionDrain({ client, outbox, delivery: delivery(), now: () => 12_000 }).drain();

    expect(posted).toHaveLength(1);
    const decision = (await client.execute("SELECT recorded_at FROM todo_decisions")).rows[0];
    expect(decision?.recorded_at).toBe(12_000);
    expect(await listPendingTodos(client)).resolves.toEqual([]);
  });
});
