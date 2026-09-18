import type { Client } from "@libsql/client";
import { recordConfirmedTodoDecisions } from "../notion/todo-decision-record.js";
import { payloadHash, type NotionOutbox, type NotionOutboxDelivery } from "../notion/outbox.js";
import { parsePendingTodoId, readPendingTodo, readTodoDecisionState, type PendingTodoDetail, type TodoDecisionState } from "./pending-todo.js";

/**
 * The one write the console may perform: a person's decision on a todo that is
 * already waiting.
 *
 * There is no create, no edit and no "move this work on" here, and no route
 * elsewhere offers one. A todo exists because the ledger is already waiting;
 * this module can only answer it, and only in the shape its kind allows.
 *
 * Two durable things happen, in this order:
 *
 *  1. `submit` inserts one `todo_decisions` row and one `notion_outbox` row in
 *     the same batch. The outbox row is the write that has to reach the Notion
 *     entry; it carries the exact comments. Either both exist or neither does,
 *     so a crash can never leave a person believing they decided something the
 *     system has no record of.
 *  2. The drain posts those comments and, once Notion has confirmed them,
 *     records them as the person's own input in the ledger. Only then does the
 *     todo count as processed and the work continue from it.
 *
 * The order is the requirement, not an implementation detail: work that
 * continued from a decision Notion never kept would be work nobody can audit.
 */

export const TODO_DECISION_OPERATION = "record_todo_decision";

/**
 * One comment the decision puts on the Notion entry.
 *
 * `mirror` says whether it is also the person's recorded input in the ledger.
 * A conclusion comment is; the extra note attached to an approval is not,
 * because both lanes read every comment on a page whose draft is still waiting
 * as a word about that draft -- a note read first would turn the approval into
 * a request to rewrite it. The note is still posted, so the page keeps what
 * the person wrote.
 */
export interface TodoDecisionComment {
  readonly body: string;
  readonly mirror: boolean;
}

export type TodoApprovalConclusion = "approve" | "rework";

/** One pick in a clarification round. `optionLetter` is null for a question
 * that offered no options, which is the only case `text` is read. */
export interface TodoChoiceAnswer {
  readonly questionIndex: number;
  readonly optionLetter: string | null;
  readonly text: string;
}

export type TodoSubmission =
  | { readonly kind: "answer"; readonly answer: string; readonly submittedBy: string }
  | {
      readonly kind: "approve";
      readonly conclusion: TodoApprovalConclusion;
      /** Optional. Never required: the conclusion alone is a complete answer. */
      readonly note: string;
      readonly submittedBy: string;
    }
  | {
      readonly kind: "choose";
      readonly answers: readonly TodoChoiceAnswer[];
      readonly note: string;
      readonly submittedBy: string;
    };

/** Why a submission was refused. Codes, not sentences: the console owns the
 * words a person reads, and this side owns the rule. */
export type TodoValidationIssue =
  | "empty_answer"
  | "empty_choice"
  | "unknown_option"
  | "unknown_question"
  | "unknown_conclusion";

export type TodoSubmitOutcome =
  | { readonly kind: "accepted"; readonly state: TodoDecisionState }
  /** The todo is not waiting and has no recorded decision: it was answered,
   * the card moved on, or it never existed. Nothing is written. */
  | { readonly kind: "gone" }
  | { readonly kind: "invalid"; readonly issues: readonly TodoValidationIssue[] };

/**
 * Posts what is in the outbox and records what Notion confirmed.
 *
 * The orchestrator owns it because it holds the gateway, and it is the same
 * function the cycle runs: a submit that cannot reach Notion leaves a durable
 * row behind, and the cycle picks that row up on its own. Absent (a read-only
 * console, a unit test), a submit stays queued and reports `awaiting_notion`.
 */
export interface TodoDecisionDrainPort {
  drain(): Promise<void>;
}

/** The decision record and the one write path onto it. */
export interface TodoDecisionStore {
  /**
   * Records one decision and tries to have it confirmed.
   *
   * Resolves to `accepted` with the state that follows: `processed` when
   * Notion confirmed in this call, `awaiting_notion` when the write is queued,
   * `retryable` when it gave up and a person has to ask again. A decision
   * already recorded for this todo is returned unchanged instead of replaced:
   * exclusion between two submitters is the primary key on `todo_decisions`,
   * and no lease is involved.
   */
  submit(todoId: string, submission: TodoSubmission): Promise<TodoSubmitOutcome>;

  /**
   * What "check the save" does: drains the queued writes, records the ones
   * Notion confirmed, re-queues one that gave up, and answers with where the
   * decision stands now. It never composes a new decision -- it re-sends the
   * one already recorded, exactly as the person submitted it. Null when this
   * todo has no decision.
   */
  recheck(todoId: string): Promise<TodoDecisionState | null>;
}

/**
 * The words a decision writes, in the form the lanes that read them expect.
 *
 * Pure: the same todo and the same submission always produce the same
 * comments, which is what lets the outbox dedupe a retry and a replay.
 *
 *  - answer  `<questionKey>: <answer>` -- the Story lane reads a keyed answer
 *            as settling that question.
 *  - approve `批准` exactly, because that is the only word both the epic and
 *            the requirement lanes accept as an approval; a note, when there
 *            is one, travels as a second comment that is posted but not read.
 *            A rework conclusion is the note itself, or `要求返工` when the
 *            person wrote nothing, and both lanes read any other word on a
 *            waiting draft as a request to rewrite it.
 *  - choose  one line per question: the lettered form (`1A`) where the round
 *            offered options, so the letter keeps its meaning when the answer
 *            is read back, and the person's own words where it did not.
 */
export function composeTodoDecisionComments(
  todo: PendingTodoDetail,
  submission: TodoSubmission,
): readonly TodoDecisionComment[] {
  if (submission.kind === "answer") {
    const source = parsePendingTodoId(todo.todoId);
    if (!source || source.kind !== "answer") throw new Error(`todo ${todo.todoId} is not an answer`);
    return [{ body: `${source.questionKey}: ${submission.answer.trim()}`, mirror: true }];
  }
  if (submission.kind === "approve") {
    const note = submission.note.trim();
    if (submission.conclusion === "rework") {
      // Any word that is not the approval on a waiting draft is read as a
      // request to rewrite it, so the note is the conclusion and nothing else
      // is sent. With no note, the request still has to be sayable.
      return [{ body: note === "" ? "要求返工" : note, mirror: true }];
    }
    const comments: TodoDecisionComment[] = [{ body: "批准", mirror: true }];
    // Posted, never recorded: both lanes read every comment on a waiting draft
    // as a verdict on it, and a note read first would turn the approval into a
    // rework request. The person still sees what they wrote on the page.
    if (note !== "") comments.push({ body: note, mirror: false });
    return comments;
  }
  const lines = submission.answers.map((answer) => {
    const letter = answer.optionLetter;
    return letter === null || letter === "" ? answer.text.trim() : `${answer.questionIndex}${letter}`;
  }).filter((line) => line !== "");
  const note = submission.note.trim();
  return [{ body: note === "" ? lines.join("\n") : [...lines, note].join("\n"), mirror: true }];
}

function validateSubmission(todo: PendingTodoDetail, submission: TodoSubmission): readonly TodoValidationIssue[] {
  if (submission.kind !== todo.kind) {
    return [todo.kind === "answer" ? "empty_answer" : todo.kind === "approve" ? "unknown_conclusion" : "empty_choice"];
  }
  if (submission.kind === "answer") {
    return submission.answer.trim() === "" ? ["empty_answer"] : [];
  }
  if (submission.kind === "approve") {
    return submission.conclusion === "approve" || submission.conclusion === "rework" ? [] : ["unknown_conclusion"];
  }
  if (submission.answers.length === 0) return ["empty_choice"];
  const issues = new Set<TodoValidationIssue>();
  for (const answer of submission.answers) {
    const question = todo.questions.find((item) => item.index === answer.questionIndex);
    if (!question) {
      issues.add("unknown_question");
      continue;
    }
    const letter = answer.optionLetter;
    if (letter === null || letter === "") {
      if (question.options.length > 0 && answer.text.trim() === "") issues.add("empty_choice");
      continue;
    }
    if (!question.options.some((option) => option.id.toLowerCase() === letter.toLowerCase())) {
      issues.add("unknown_option");
    }
  }
  return [...issues];
}

export function createTodoDecisionStore(deps: {
  client: Client;
  outbox: NotionOutbox;
  drain?: TodoDecisionDrainPort | undefined;
  now?: () => number;
}): TodoDecisionStore {
  const now = deps.now ?? Date.now;

  async function outboxRow(todoId: string): Promise<{ id: number; state: string } | null> {
    const row = (await deps.client.execute({
      sql: `SELECT o.id, o.state FROM todo_decisions d
            JOIN notion_outbox o ON o.id = d.outbox_id WHERE d.todo_id = ?`,
      args: [todoId],
    })).rows[0];
    return row ? { id: Number(row.id), state: String(row.state) } : null;
  }

  return {
    async submit(todoId, submission) {
      // A decision already recorded is the answer, not a conflict: the person
      // asking twice must not overwrite what the first request kept.
      const existing = await readTodoDecisionState(deps.client, todoId);
      if (existing !== null) return { kind: "accepted", state: existing };
      const todo = await readPendingTodo(deps.client, todoId);
      if (todo === null) return { kind: "gone" };
      const issues = validateSubmission(todo, submission);
      if (issues.length > 0) return { kind: "invalid", issues };

      const comments = composeTodoDecisionComments(todo, submission);
      const pageId = todo.notionTarget.pageId;
      const payload = { todoId, pageId, comments: comments.map((comment) => ({ body: comment.body, mirror: comment.mirror })) };
      const encoded = payloadHash(payload);
      const submittedAt = now();
      // One batch, so a crash can never leave a decision the ledger holds
      // without the write that carries it, or the other way round. The second
      // statement finds the write the first one just queued; the primary key
      // on todo_id is the exclusion between two submitters.
      await deps.client.batch([
        {
          sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
                VALUES (NULL, 0, ?, ?, ?, ?, ?)
                ON CONFLICT(target, payload_hash) DO NOTHING`,
          args: [TODO_DECISION_OPERATION, pageId, encoded.json, encoded.hash, submittedAt],
        },
        {
          sql: `INSERT INTO todo_decisions
                  (todo_id, kind, subject_kind, subject_id, page_id, comments, submitted_by, submitted_at, outbox_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM notion_outbox WHERE target = ? AND payload_hash = ?))
                ON CONFLICT(todo_id) DO NOTHING`,
          args: [
            todoId,
            todo.kind,
            todo.subject.kind,
            todo.subject.id,
            pageId,
            JSON.stringify(comments),
            submission.submittedBy,
            submittedAt,
            pageId,
            encoded.hash,
          ],
        },
      ], "write");

      if (deps.drain) await deps.drain.drain();
      const state = await readTodoDecisionState(deps.client, todoId);
      return { kind: "accepted", state: state ?? { status: "awaiting_notion", submittedAt } };
    },

    async recheck(todoId) {
      if ((await readTodoDecisionState(deps.client, todoId)) === null) return null;
      if (deps.drain) {
        await deps.drain.drain();
        // A write that gave up is put back in the queue and tried again,
        // unchanged: a person asking about the save is not extending the
        // budget that produced the failure, and never a new decision.
        const row = await outboxRow(todoId);
        if (row && row.state === "dead") {
          await deps.outbox.requeue(row.id);
          await deps.drain.drain();
        }
      }
      return readTodoDecisionState(deps.client, todoId);
    },
  };
}

/**
 * The drain the orchestrator hands to the console: deliver the pending todo
 * writes, then record the confirmed ones as ledger input.
 *
 * Both halves are idempotent, so running it on the cycle, on a submit, and on
 * a "check the save" all mean the same thing. The cycle wiring calls
 * `drain()` once per pass alongside the other outbox operations.
 */
export function createTodoDecisionDrain(deps: {
  client: Client;
  outbox: NotionOutbox;
  delivery: NotionOutboxDelivery;
  now?: () => number;
}): TodoDecisionDrainPort {
  const now = deps.now;
  return {
    async drain() {
      await deps.outbox.replay(deps.delivery, { operations: [TODO_DECISION_OPERATION] });
      await recordConfirmedTodoDecisions(deps.client, now ? { now } : undefined);
    },
  };
}
