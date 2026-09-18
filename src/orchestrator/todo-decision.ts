import type { Client } from "@libsql/client";
import type { NotionOutbox, NotionOutboxDelivery } from "../notion/outbox.js";
import type { PendingTodoDetail, TodoDecisionState } from "./pending-todo.js";

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
  throw new Error(`composing the comments for ${todo.todoId} (${submission.kind}) is not implemented yet`);
}

export function createTodoDecisionStore(deps: {
  client: Client;
  outbox: NotionOutbox;
  drain?: TodoDecisionDrainPort | undefined;
  now?: () => number;
}): TodoDecisionStore {
  throw new Error(`the todo decision store is not implemented yet (${deps.client ? "client given" : "no client"})`);
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
  throw new Error(`the todo decision drain is not implemented yet (${deps.outbox ? "outbox given" : "no outbox"})`);
}
