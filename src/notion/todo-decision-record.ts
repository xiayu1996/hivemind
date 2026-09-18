import type { Client } from "@libsql/client";

/**
 * Turns a confirmed decision into the person's own input in the ledger.
 *
 * The console writes a decision onto the Notion entry (through the outbox) and
 * stops there. The lanes that already own human input do the rest, unchanged:
 *
 *   - a decision on a stopped Story becomes a `human_feedback` row, and
 *     `answerOpenQuestion` plus the transition out of NEEDS_INPUT follow from
 *     the existing comment reader;
 *   - a decision on a requirement draft or an Epic's split becomes the
 *     approval event those lanes already claim by comment id;
 *   - a pick in a clarification round becomes the round's answers.
 *
 * So this module writes the record those readers look for, and nothing else.
 * There is no second implementation of "a person answered": one road, whether
 * the words arrived from a Notion comment or from the console.
 *
 * Why a copy in `ingested_comments` rather than a new channel: the readers all
 * filter comments by author, and a comment this process posted is the bot's,
 * so the page would keep the decision and no lane would ever read it. The row
 * written here is the same record a polled comment produces, with the person's
 * name on it and an id derived from the outbox row, which is what keeps a
 * replay from recording it twice.
 */

/** `todo-decision:<outbox row id>:<comment index>`: unique per decision
 * comment, stable across replays, and never a real Notion comment id. */
export function todoDecisionCommentId(outboxId: number, index: number): string {
  return `todo-decision:${outboxId}:${index}`;
}

export interface TodoDecisionRecordFailure {
  readonly todoId: string;
  readonly detail: string;
}

export interface TodoDecisionRecordResult {
  /** Decisions that became ledger input in this pass. */
  readonly recorded: number;
  /** Decisions whose write has not been confirmed by Notion yet, plus any that
   * failed to record. They stay waiting; the next pass tries again. */
  readonly failed: number;
  readonly failures: readonly TodoDecisionRecordFailure[];
}

/**
 * Records every decision whose Notion write is confirmed and that is not
 * recorded yet.
 *
 * Only `state = 'sent'` qualifies: a queued row has not reached Notion, and a
 * dead one never did. That is the whole gate behind "the work continues only
 * after the result is kept" -- the lanes resume because this row appeared, and
 * this row appears only after the comment is on the page.
 *
 * Safe to run on every cycle of every process that shares the database: the
 * insert is keyed by the outbox row, and `recorded_at` is only ever set once.
 */
export async function recordConfirmedTodoDecisions(
  client: Client,
  options?: { now?: () => number; limit?: number },
): Promise<TodoDecisionRecordResult> {
  throw new Error(`recording confirmed todo decisions is not implemented yet (${options?.limit ?? "no limit"})`);
}
