import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import {
  firstPendingTodoId,
  listPendingTodos,
  parsePendingTodoId,
  pendingTodoId,
  readPendingTodo,
  readTodoDecisionState,
  type PendingTodoSource,
} from "./pending-todo.js";

/**
 * Fixtures are inserted straight into the migrated ledger. The projection only
 * reads, so it must see exactly what the columns say and nothing else.
 */
async function insertStory(
  client: Client,
  id: string,
  pageId: string,
  title: string,
  extra: { state?: string; stopReason?: string | null; epicId?: string | null; createdAt?: number } = {},
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, epic_id, created_at, updated_at)
          VALUES (?, ?, ?, '原文', ?, ?, ?, ?, ?)`,
    args: [
      id,
      pageId,
      title,
      extra.state ?? "NEEDS_INPUT",
      extra.stopReason === undefined ? "blocking_question" : extra.stopReason,
      extra.epicId ?? null,
      extra.createdAt ?? 1_000,
      extra.createdAt ?? 1_000,
    ],
  });
}

async function insertQuestion(
  client: Client,
  cardId: string,
  key: string,
  createdAt: number,
  extra: { blocking?: number; answer?: string | null; question?: string; suggestion?: string } = {},
): Promise<void> {
  const answer = extra.answer ?? null;
  await client.execute({
    sql: `INSERT INTO open_questions (card_id, question_key, question, suggestion, blocking, answer, answered_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      cardId,
      key,
      extra.question ?? "要不要先发提醒？",
      extra.suggestion ?? "先不发",
      extra.blocking ?? 1,
      answer,
      answer === null ? null : createdAt + 1,
      createdAt,
    ],
  });
}

async function insertRequirement(
  client: Client,
  id: string,
  pageId: string,
  title: string,
  state: string,
  createdAt = 1_000,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
          VALUES (?, ?, ?, ?, '原文', ?, ?)`,
    args: [id, pageId, title, state, createdAt, createdAt],
  });
}

async function insertDraftPrd(
  client: Client,
  requirementId: string,
  createdAt: number,
  businessGoal = "值班的人随时知道卡在哪",
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at)
          VALUES (?, 1, ?, 'draft', ?)`,
    args: [
      requirementId,
      JSON.stringify({ businessGoal, nonGoals: [], scenarios: [], openQuestions: [] }),
      createdAt,
    ],
  });
}

async function insertEpic(
  client: Client,
  id: string,
  pageId: string,
  title: string,
  state: string,
  requirementId: string | null,
  createdAt = 1_000,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, pageId, title, state, requirementId, createdAt, createdAt],
  });
}

async function insertEpicPlan(
  client: Client,
  epicId: string,
  createdAt: number,
  businessGoal = "这一批的目标",
): Promise<void> {
  const body = {
    kind: "accepted",
    epicId,
    businessGoal,
    stories: [{ id: `S-${epicId}-01`, title: "第一件" }],
  };
  await client.execute({
    sql: "INSERT INTO epic_plans (epic_id, body, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: [epicId, JSON.stringify(body), createdAt, createdAt],
  });
}

async function insertClarifyRound(
  client: Client,
  requirementId: string,
  round: number,
  askedAt: number,
  options: { answered?: boolean } = {},
): Promise<void> {
  const questions = [
    {
      question: "手机优先吗？",
      context: "决定这一版先交付哪一端。",
      options: [{ label: "先做手机端" }, { label: "先做桌面端", recommended: true }],
    },
  ];
  await client.execute({
    sql: `INSERT INTO requirement_clarify_rounds (requirement_id, round, questions, asked_at, answered_at, answers)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      requirementId,
      round,
      JSON.stringify(questions),
      askedAt,
      options.answered ? askedAt + 1 : null,
      options.answered ? JSON.stringify(["先做桌面端"]) : null,
    ],
  });
}

async function insertDecision(
  client: Client,
  input: {
    todoId: string;
    kind: string;
    subjectKind: string;
    subjectId: string;
    pageId: string;
    submittedAt: number;
    outboxState: string;
    lastError?: string | null;
    recordedAt?: number | null;
    body?: string;
  },
): Promise<number> {
  const comments = JSON.stringify([{ body: input.body ?? `${input.subjectId}: 先不发`, mirror: true }]);
  const result = await client.execute({
    sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, state, attempts, last_error, created_at, sent_at)
          VALUES (NULL, 0, 'record_todo_decision', ?, ?, ?, ?, 1, ?, ?, ?)`,
    args: [
      input.pageId,
      JSON.stringify({ todoId: input.todoId, pageId: input.pageId, comments: JSON.parse(comments) }),
      `hash-${input.todoId}`,
      input.outboxState,
      input.lastError ?? null,
      input.submittedAt,
      input.outboxState === "sent" ? input.submittedAt : null,
    ],
  });
  const outboxId = Number(result.lastInsertRowid);
  await client.execute({
    sql: `INSERT INTO todo_decisions
            (todo_id, kind, subject_kind, subject_id, page_id, comments, submitted_by, submitted_at, outbox_id, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, '本人', ?, ?, ?)`,
    args: [
      input.todoId,
      input.kind,
      input.subjectKind,
      input.subjectId,
      input.pageId,
      comments,
      input.submittedAt,
      outboxId,
      input.recordedAt ?? null,
    ],
  });
  return outboxId;
}

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

afterEach(() => client.close());

describe("todo ids", () => {
  it("spells the id from the source alone", () => {
    expect(pendingTodoId({ kind: "answer", storyId: "S-EPIC1-01", questionKey: "q1" }))
      .toBe("answer:S-EPIC1-01:q1");
    expect(pendingTodoId({ kind: "approve", scope: "requirement", requirementId: "R-1", artifact: "prd" }))
      .toBe("approve:requirement:R-1:prd");
    expect(pendingTodoId({ kind: "approve", scope: "requirement", requirementId: "R-1", artifact: "solution" }))
      .toBe("approve:requirement:R-1:solution");
    expect(pendingTodoId({ kind: "approve", scope: "epic", epicId: "EPIC1" }))
      .toBe("approve:epic:EPIC1");
    expect(pendingTodoId({ kind: "choose", requirementId: "R-1", round: 2 }))
      .toBe("choose:R-1:2");
  });

  it("round-trips every source form", () => {
    const sources: PendingTodoSource[] = [
      { kind: "answer", storyId: "S-EPIC1-01", questionKey: "q1" },
      { kind: "approve", scope: "requirement", requirementId: "R-1", artifact: "prd" },
      { kind: "approve", scope: "requirement", requirementId: "R-1", artifact: "solution" },
      { kind: "approve", scope: "epic", epicId: "EPIC1" },
      { kind: "choose", requirementId: "R-1", round: 2 },
    ];
    for (const source of sources) expect(parsePendingTodoId(pendingTodoId(source))).toEqual(source);
  });

  it("rejects anything that is not one of the three forms", () => {
    const rejected = [
      "",
      "answer",
      "answer:S-1",
      "answer:S-1:q1:extra",
      "approve:R-1",
      "approve:story:S-1",
      "approve:epic:",
      "choose:R-1",
      "choose:R-1:x",
      "reply:S-1:q1",
      "1answer:S-1:q1",
    ];
    for (const value of rejected) expect(parsePendingTodoId(value)).toBeNull();
  });
});

describe("the waiting list", () => {
  it("projects a blocked story question as an answer todo", async () => {
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事");
    await insertQuestion(client, "S-EPIC1-01", "q1", 1_500);

    const todos = await listPendingTodos(client);

    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      todoId: "answer:S-EPIC1-01:q1",
      kind: "answer",
      title: "要不要先发提醒？",
      waitingSince: 1_500,
      subject: { kind: "story", id: "S-EPIC1-01", title: "回答一件事", pageId: "page-story" },
      decision: null,
    });
  });

  it("lists one todo per unanswered blocking question", async () => {
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事");
    await insertQuestion(client, "S-EPIC1-01", "q1", 1_500);
    await insertQuestion(client, "S-EPIC1-01", "q2", 1_600);

    const ids = (await listPendingTodos(client)).map((todo) => todo.todoId).toSorted();

    expect(ids).toEqual(["answer:S-EPIC1-01:q1", "answer:S-EPIC1-01:q2"]);
  });

  it("does not list a question that is not blocking or already answered", async () => {
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事");
    await insertQuestion(client, "S-EPIC1-01", "soft", 1_500, { blocking: 0 });
    await insertQuestion(client, "S-EPIC1-01", "done", 1_600, { answer: "已经回了" });

    await expect(listPendingTodos(client)).resolves.toEqual([]);
  });

  it("does not list a story that is not stopped on a blocking question", async () => {
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事", { state: "CODE", stopReason: null });
    await insertQuestion(client, "S-EPIC1-01", "q1", 1_500);

    await expect(listPendingTodos(client)).resolves.toEqual([]);
  });

  it("projects a draft PRD waiting for approval and names its requirement", async () => {
    await insertRequirement(client, "R-1", "page-req", "控制台", "PRD_CONFIRM");
    await insertDraftPrd(client, "R-1", 2_000);

    const todos = await listPendingTodos(client);

    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      todoId: "approve:requirement:R-1:prd",
      kind: "approve",
      waitingSince: 2_000,
      subject: { kind: "requirement", id: "R-1", title: "控制台", pageId: "page-req", requirementId: "R-1" },
      decision: null,
    });
  });

  it("does not list a PRD that is no longer a draft", async () => {
    await insertRequirement(client, "R-1", "page-req", "控制台", "PRD_CONFIRM");
    await insertDraftPrd(client, "R-1", 2_000);
    await client.execute(
      "UPDATE requirement_prds SET status = 'confirmed', confirmed_at = 2500 WHERE requirement_id = 'R-1'",
    );

    await expect(listPendingTodos(client)).resolves.toEqual([]);
  });

  it("projects an Epic split waiting for approval", async () => {
    await insertRequirement(client, "R-1", "page-req", "控制台", "SOLUTION");
    await insertEpic(client, "EPIC1", "page-epic", "第一拆", "PLAN_APPROVAL", "R-1");
    await insertEpicPlan(client, "EPIC1", 3_000);

    const todos = await listPendingTodos(client);

    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      todoId: "approve:epic:EPIC1",
      kind: "approve",
      waitingSince: 3_000,
      subject: {
        kind: "epic",
        id: "EPIC1",
        title: "第一拆",
        pageId: "page-epic",
        requirementId: "R-1",
        requirementTitle: "控制台",
      },
    });
  });

  it("does not list an Epic split whose body is missing", async () => {
    await insertEpic(client, "EPIC1", "page-epic", "第一拆", "PLAN_APPROVAL", null);

    await expect(listPendingTodos(client)).resolves.toEqual([]);
  });

  it("projects only the latest clarification round as a choice", async () => {
    await insertRequirement(client, "R-1", "page-req", "控制台", "CLARIFY");
    await insertClarifyRound(client, "R-1", 1, 4_000, { answered: true });
    await insertClarifyRound(client, "R-1", 2, 5_000);

    const todos = await listPendingTodos(client);

    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      todoId: "choose:R-1:2",
      kind: "choose",
      title: "手机优先吗？",
      waitingSince: 5_000,
    });
  });

  it("does not list a clarification whose latest round was answered", async () => {
    await insertRequirement(client, "R-1", "page-req", "控制台", "CLARIFY");
    await insertClarifyRound(client, "R-1", 1, 4_000, { answered: true });

    await expect(listPendingTodos(client)).resolves.toEqual([]);
  });

  it("orders todos oldest first regardless of kind", async () => {
    await insertRequirement(client, "R-1", "page-req", "控制台", "PRD_CONFIRM");
    await insertDraftPrd(client, "R-1", 500);
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事");
    await insertQuestion(client, "S-EPIC1-01", "q1", 1_500);

    const ids = (await listPendingTodos(client)).map((todo) => todo.todoId);

    expect(ids).toEqual(["approve:requirement:R-1:prd", "answer:S-EPIC1-01:q1"]);
  });

  it("@scenario S-R237511TD-01-savefail keeps a submitted but unconfirmed decision on the list as unhandled", async () => {
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事");
    await insertQuestion(client, "S-EPIC1-01", "q1", 1_500);
    await insertDecision(client, {
      todoId: "answer:S-EPIC1-01:q1",
      kind: "answer",
      subjectKind: "story",
      subjectId: "S-EPIC1-01",
      pageId: "page-story",
      submittedAt: 6_000,
      outboxState: "pending",
    });

    const todos = await listPendingTodos(client);

    expect(todos).toHaveLength(1);
    expect(todos[0]?.decision).toEqual({ status: "awaiting_notion", submittedAt: 6_000 });
  });

  it("drops a todo once the decision is recorded as the person's own input", async () => {
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事");
    await insertQuestion(client, "S-EPIC1-01", "q1", 1_500);
    await insertDecision(client, {
      todoId: "answer:S-EPIC1-01:q1",
      kind: "answer",
      subjectKind: "story",
      subjectId: "S-EPIC1-01",
      pageId: "page-story",
      submittedAt: 6_000,
      outboxState: "sent",
      recordedAt: 7_000,
    });

    await expect(listPendingTodos(client)).resolves.toEqual([]);
  });

  it("@scenario S-R237511TD-01-existing returns the oldest waiting todo, or null when nothing waits", async () => {
    await expect(firstPendingTodoId(client)).resolves.toBeNull();

    await insertRequirement(client, "R-1", "page-req", "控制台", "PRD_CONFIRM");
    await insertDraftPrd(client, "R-1", 500);
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事");
    await insertQuestion(client, "S-EPIC1-01", "q1", 1_500);

    await expect(firstPendingTodoId(client)).resolves.toBe("approve:requirement:R-1:prd");
  });
});

describe("the recorded decision state", () => {
  it("is null when nothing was submitted for this todo", async () => {
    await expect(readTodoDecisionState(client, "answer:S-EPIC1-01:q1")).resolves.toBeNull();
  });

  it("reports a queued decision as still waiting on Notion", async () => {
    await insertDecision(client, {
      todoId: "answer:S-EPIC1-01:q1",
      kind: "answer",
      subjectKind: "story",
      subjectId: "S-EPIC1-01",
      pageId: "page-story",
      submittedAt: 6_000,
      outboxState: "pending",
    });

    await expect(readTodoDecisionState(client, "answer:S-EPIC1-01:q1"))
      .resolves.toEqual({ status: "awaiting_notion", submittedAt: 6_000 });
  });

  it("reports a write that gave up as retryable", async () => {
    await insertDecision(client, {
      todoId: "answer:S-EPIC1-01:q1",
      kind: "answer",
      subjectKind: "story",
      subjectId: "S-EPIC1-01",
      pageId: "page-story",
      submittedAt: 6_000,
      outboxState: "dead",
      lastError: "notion 503",
    });

    const state = await readTodoDecisionState(client, "answer:S-EPIC1-01:q1");

    expect(state).toMatchObject({ status: "retryable", submittedAt: 6_000 });
    expect(state?.status === "retryable" ? state.detail : "").toContain("503");
  });

  it("reports a confirmed and recorded decision as processed", async () => {
    await insertDecision(client, {
      todoId: "answer:S-EPIC1-01:q1",
      kind: "answer",
      subjectKind: "story",
      subjectId: "S-EPIC1-01",
      pageId: "page-story",
      submittedAt: 6_000,
      outboxState: "sent",
      recordedAt: 7_000,
    });

    await expect(readTodoDecisionState(client, "answer:S-EPIC1-01:q1"))
      .resolves.toEqual({ status: "processed", submittedAt: 6_000, recordedAt: 7_000 });
  });
});

describe("one todo in full", () => {
  it("@scenario S-R237511TD-01-open shows what an approval is about, its two conclusions and its Notion target", async () => {
    await insertRequirement(client, "R-1", "page-req", "控制台", "PRD_CONFIRM");
    await insertDraftPrd(client, "R-1", 2_000, "值班的人随时知道每张卡在哪一步");

    const detail = await readPendingTodo(client, "approve:requirement:R-1:prd");

    expect(detail?.kind).toBe("approve");
    expect(detail?.questions).toEqual([]);
    expect(detail?.conclusions.map((option) => option.id)).toEqual(["approve", "rework"]);
    expect(detail?.conclusions.every((option) => option.recommended === false)).toBe(true);
    expect(detail?.notionTarget).toMatchObject({ kind: "requirement", id: "R-1", title: "控制台", pageId: "page-req" });
    expect(detail?.notionTarget.pageUrl).toContain("page-req");
    expect(detail?.sections.some((section) => section.id === "prd_goal" && section.text.includes("值班的人随时知道每张卡在哪一步")))
      .toBe(true);
  });

  it("@scenario S-R237511TD-01-open shows an answer question with the agent's suggestion and no option", async () => {
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事");
    await insertQuestion(client, "S-EPIC1-01", "q1", 1_500, { suggestion: "先不发" });

    const detail = await readPendingTodo(client, "answer:S-EPIC1-01:q1");

    expect(detail?.kind).toBe("answer");
    expect(detail?.questions).toHaveLength(1);
    expect(detail?.questions[0]).toMatchObject({
      index: 1,
      question: "要不要先发提醒？",
      suggestion: "先不发",
      options: [],
    });
    expect(detail?.conclusions).toEqual([]);
    expect(detail?.notionTarget).toMatchObject({ kind: "story", id: "S-EPIC1-01", pageId: "page-story" });
  });

  it("@scenario S-R237511TD-01-open shows a choice's lettered options and marks the recommended one without choosing it", async () => {
    await insertRequirement(client, "R-1", "page-req", "控制台", "CLARIFY");
    await insertClarifyRound(client, "R-1", 1, 4_000);

    const detail = await readPendingTodo(client, "choose:R-1:1");

    expect(detail?.kind).toBe("choose");
    expect(detail?.questions).toHaveLength(1);
    expect(detail?.questions[0]?.options).toEqual([
      { id: "A", label: "先做手机端", recommended: false },
      { id: "B", label: "先做桌面端", recommended: true },
    ]);
    expect(detail?.conclusions).toEqual([]);
  });

  it("@scenario S-R237511TD-01-open returns null only for an id that was never a todo", async () => {
    await expect(readPendingTodo(client, "answer:S-EPIC1-01:q1")).resolves.toBeNull();
    await expect(readPendingTodo(client, "not-a-todo-id")).resolves.toBeNull();
  });

  it("still says what happened for a todo whose decision is already recorded", async () => {
    await insertStory(client, "S-EPIC1-01", "page-story", "回答一件事");
    await insertQuestion(client, "S-EPIC1-01", "q1", 1_500, { answer: "先不发" });
    await insertDecision(client, {
      todoId: "answer:S-EPIC1-01:q1",
      kind: "answer",
      subjectKind: "story",
      subjectId: "S-EPIC1-01",
      pageId: "page-story",
      submittedAt: 6_000,
      outboxState: "sent",
      recordedAt: 7_000,
    });

    const detail = await readPendingTodo(client, "answer:S-EPIC1-01:q1");

    expect(detail?.todoId).toBe("answer:S-EPIC1-01:q1");
    expect(detail?.decision).toEqual({ status: "processed", submittedAt: 6_000, recordedAt: 7_000 });
  });
});
