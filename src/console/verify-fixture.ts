import type { Client } from "@libsql/client";
import { TODO_DECISION_OPERATION } from "../orchestrator/todo-decision.js";

/**
 * The sample data the todo scenarios are written about.
 *
 * `serve-console.ts` exists for one purpose: to give a verification round a
 * running console whose pages can be judged. The pages these scenarios judge
 * are pages of a waiting todo -- a requirement whose approval waits, a Story
 * stopped on a question, a requirement waiting on a choice -- and the ledger a
 * worktree serves holds none of them at the moment a round runs. The
 * repository declares each scenario's sample data and `verify.seedCommand` is
 * where a seed process is supposed to put it into the running application;
 * a console that serves a private snapshot cannot be reached that way, because
 * the seed process does not know the path of a copy taken at startup, so this
 * entry point materializes the same data itself.
 *
 * Nothing here belongs in the daemon: the product console reads the real
 * ledger, and inventing waiting work there would be a second account of what a
 * person has to do. It is scoped to the verification entry point, and it is
 * idempotent -- every application resets its own rows first -- so the same
 * scenario served twice is the same picture.
 *
 * The scenario named on the request selects the fixture. The suffix of a
 * scenario id is the state it is about (`...-answer` asks for a waiting
 * question), and the empty-state suffixes are the scenarios whose whole point
 * is that nothing waits: seeding those would take away the state they exist to
 * judge. A request that names no scenario is one of those empty states -- the
 * sample rows are cleared instead of seeded -- because a person who opens the
 * todo page when nothing waits must read that, not a waiting todo a scenario
 * about something else left behind.
 */

/** The ledger rows this module owns. Fixed so a reset can find them again. */
const ANSWER_STORY = "S-R237-ANSWER";
const SAVE_STORY = "S-R237-SAVE";
const APPROVE_REQUIREMENT = "R-237511-TODO";
const CHOICE_REQUIREMENT = "R-237511-CHOICE";
const FIXTURE_STORY_IDS = [ANSWER_STORY, SAVE_STORY];
const FIXTURE_REQUIREMENT_IDS = [APPROVE_REQUIREMENT, CHOICE_REQUIREMENT];
const FIXTURE_PAGE_IDS = [...FIXTURE_STORY_IDS, ...FIXTURE_REQUIREMENT_IDS].map((id) => `page-${id}`);

export type VerifyFixture = "full" | "answer" | "approve" | "choose" | "savefail" | "rejected" | "empty" | "error";

/** The word a scenario id ends in, which is the state that scenario is about. */
function stateOf(scenarioId: string): string {
  const suffix = scenarioId.slice(scenarioId.lastIndexOf("-") + 1).toLowerCase();
  return suffix;
}

/** Which fixture a scenario asks for. A request that names no scenario gets the
 * empty state: the plain page is the one the "nothing is waiting" scenarios
 * are written about, and seeding it would take that state away. */
export function fixtureFor(scenarioId: string | null): VerifyFixture {
  if (scenarioId === null || scenarioId === "") return "empty";
  switch (stateOf(scenarioId)) {
    case "answer":
      return "answer";
    case "open":
    case "approve":
      return "approve";
    case "choose":
      return "choose";
    case "savefail":
      return "savefail";
    case "rejected":
      // A scenario about a submission the ledger refuses: the same waiting
      // question, but the entry point makes the delivery fail so the screen
      // has to say the answer was not submitted and keep the todo.
      return "rejected";
    case "error":
      // A read that did not work is its own state, not the empty ledger: the
      // page says it could not read the todo and offers to try again, and the
      // entry point makes the read fail for it. Reading it as `empty` is what
      // made the failed-read scenario show "目前没有待办" instead.
      return "error";
    case "existing":
    case "empty":
    case "loading":
      return "empty";
    // An id whose state this table does not know is a scenario about something
    // else; the full sample set is the answer that keeps a waiting page on
    // screen rather than an empty one, which is what every failure looked like.
    default:
      return "full";
  }
}

/** The scenario id a request names, or null when it names none. */
export function scenarioOfUrl(url: string): string | null {
  const queryAt = url.indexOf("?");
  if (queryAt === -1) return null;
  return new URLSearchParams(url.slice(queryAt + 1)).get("scenario");
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

async function resetFixtureRows(client: Client): Promise<void> {
  await client.batch([
    {
      sql: `DELETE FROM todo_decisions WHERE subject_id IN (${placeholders(FIXTURE_STORY_IDS.length + FIXTURE_REQUIREMENT_IDS.length)})`,
      args: [...FIXTURE_STORY_IDS, ...FIXTURE_REQUIREMENT_IDS],
    },
    {
      sql: `DELETE FROM notion_outbox WHERE operation = ? AND target IN (${placeholders(FIXTURE_PAGE_IDS.length)})`,
      args: [TODO_DECISION_OPERATION, ...FIXTURE_PAGE_IDS],
    },
    {
      sql: `DELETE FROM stories WHERE id IN (${placeholders(FIXTURE_STORY_IDS.length)})`,
      args: [...FIXTURE_STORY_IDS],
    },
    {
      sql: `DELETE FROM requirements WHERE id IN (${placeholders(FIXTURE_REQUIREMENT_IDS.length)})`,
      args: [...FIXTURE_REQUIREMENT_IDS],
    },
  ], "write");
}

async function seedAnswer(client: Client, now: number): Promise<void> {
  await client.batch([
    {
      sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'NEEDS_INPUT', 'blocking_question', ?, ?)`,
      args: [ANSWER_STORY, `page-${ANSWER_STORY}`, "确认提醒时间", "待办处理", now - 18 * 60_000, now - 18 * 60_000],
    },
    {
      sql: `INSERT INTO open_questions (card_id, question_key, question, suggestion, blocking, created_at)
            VALUES (?, 'q1', ?, ?, 1, ?)`,
      args: [ANSWER_STORY, "提醒应在什么时候发送？", "每天上午九点", now - 18 * 60_000],
    },
  ], "write");
}

async function seedApproval(client: Client, now: number): Promise<void> {
  // A single string literal, not an object built in code: a `then` property in
  // an object literal is read as a thenable by the linter, and `then` is a
  // field of the PRD body.
  const body = '{"businessGoal":"让本人处理已有待办","nonGoals":[],'
    + '"scenarios":[{"id":"S1","given":"后台有待批准的方案","when":"本人打开","then":"看到待批准内容"}],'
    + '"openQuestions":[]}';
  await client.batch([
    {
      sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
            VALUES (?, ?, ?, 'PRD_CONFIRM', ?, ?, ?)`,
      args: [APPROVE_REQUIREMENT, `page-${APPROVE_REQUIREMENT}`, "值班待办控制台", "本人要处理已有待办", now - 20 * 60_000, now - 20 * 60_000],
    },
    {
      sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at)
            VALUES (?, 1, ?, 'draft', ?)`,
      args: [APPROVE_REQUIREMENT, body, now - 20 * 60_000],
    },
  ], "write");
}

async function seedChoice(client: Client, now: number): Promise<void> {
  const questions = JSON.stringify([{
    question: "待办入口应放在哪里？",
    context: "决定本人从哪里进入待办处理页。",
    options: [{ label: "运行总览顶部" }, { label: "独立导航", recommended: true }],
  }]);
  await client.batch([
    {
      sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
            VALUES (?, ?, ?, 'CLARIFY', ?, ?, ?)`,
      args: [CHOICE_REQUIREMENT, `page-${CHOICE_REQUIREMENT}`, "待办入口位置", "本人要从哪里处理待办", now - 12 * 60_000, now - 12 * 60_000],
    },
    {
      sql: `INSERT INTO requirement_clarify_rounds (requirement_id, round, questions, asked_at)
            VALUES (?, 1, ?, ?)`,
      args: [CHOICE_REQUIREMENT, questions, now - 12 * 60_000],
    },
  ], "write");
}

/**
 * A todo whose decision was submitted and whose write has not been confirmed.
 *
 * It is inserted in the two rows the projection joins: the decision a person
 * made, and the outbox write that carries it. The outbox row stays `pending`,
 * so the page reads the decision as still waiting on Notion -- the exact state
 * the save scenario is about, without a submit that would depend on a delivery
 * being unreachable.
 */
async function seedSubmitted(client: Client, now: number): Promise<void> {
  const todoId = `answer:${SAVE_STORY}:q1`;
  const submittedAt = now - 5 * 60_000;
  const comments = JSON.stringify([{ body: "q1: 每天上午九点", mirror: true }]);
  const payload = JSON.stringify({ todoId, pageId: `page-${SAVE_STORY}`, comments: [{ body: "q1: 每天上午九点", mirror: true }] });
  const inserted = await client.execute({
    sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, state, attempts, created_at)
          VALUES (NULL, 0, ?, ?, ?, ?, 'pending', 1, ?)`,
    args: [TODO_DECISION_OPERATION, `page-${SAVE_STORY}`, payload, `fixture-${todoId}`, submittedAt],
  });
  const outboxId = Number(inserted.lastInsertRowid);
  await client.batch([
    {
      sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'NEEDS_INPUT', 'blocking_question', ?, ?)`,
      args: [SAVE_STORY, `page-${SAVE_STORY}`, "确认提醒时间", "待办处理", submittedAt - 60_000, submittedAt - 60_000],
    },
    {
      sql: `INSERT INTO open_questions (card_id, question_key, question, suggestion, blocking, created_at)
            VALUES (?, 'q1', ?, ?, 1, ?)`,
      args: [SAVE_STORY, "提醒应在什么时候发送？", "每天上午九点", submittedAt - 60_000],
    },
    {
      sql: `INSERT INTO todo_decisions
              (todo_id, kind, subject_kind, subject_id, page_id, comments, submitted_by, submitted_at, outbox_id)
            VALUES (?, 'answer', 'story', ?, ?, ?, '本人', ?, ?)`,
      args: [todoId, SAVE_STORY, `page-${SAVE_STORY}`, comments, submittedAt, outboxId],
    },
  ], "write");
}

/**
 * Puts the fixture's rows in the ledger, replacing whatever the previous
 * application left. Reset first so a scenario served twice, or after a round
 * submitted a decision on the sample todo, is the same picture.
 */
export async function applyVerifyFixture(client: Client, fixture: VerifyFixture, now = Date.now()): Promise<void> {
  await resetFixtureRows(client);
  // `error` is the same empty ledger the page fails to read: the failure is
  // served by the entry point, not stored in a row.
  if (fixture === "empty" || fixture === "error") return;
  if (fixture === "full" || fixture === "approve") await seedApproval(client, now);
  // `rejected` is the answer todo with no decision and no outbox row: the
  // refusal happens at delivery time, never as a stored successful decision.
  if (fixture === "full" || fixture === "answer" || fixture === "rejected") await seedAnswer(client, now);
  if (fixture === "full" || fixture === "choose") await seedChoice(client, now);
  if (fixture === "full" || fixture === "savefail") await seedSubmitted(client, now);
}
