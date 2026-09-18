import type { Client } from "@libsql/client";

/**
 * What a person still has to do, as the central ledger holds it.
 *
 * A pending todo is not a row this module creates. It is one of three states
 * the ledger is already in, projected into one shape:
 *
 *   answer  -- a Story stopped on a blocking question
 *              (`stories.stop_reason = 'blocking_question'`, state NEEDS_INPUT)
 *              with at least one unanswered blocking `open_questions` row. The
 *              person answers it on that Story's own Notion page.
 *   approve -- a requirement draft waiting for a person (state PRD_CONFIRM or
 *              SOLUTION whose latest revision is `draft`), or an Epic whose
 *              split is presented (state PLAN_APPROVAL, body in `epic_plans`).
 *              The person concludes it on the page that carries the draft.
 *   choose  -- a requirement in CLARIFY whose latest round is unanswered
 *              (`requirement_clarify_rounds.answered_at IS NULL`). The person
 *              picks on the requirement's page.
 *
 * Nothing here writes. The read is a projection over rows other parts of the
 * system own, so a console that is down cannot lose a decision and a read
 * cannot invent one. The one write path is `todo-decision.ts`.
 *
 * Deliberately not todos: the other three real stops (`verify_loop_exceeded`,
 * `retry_limit_exceeded`, `cost_ceiling_exceeded`), scenario acceptance, and a
 * requirement stopped on `blocking_question`. All of them are answered in
 * Notion today, and admitting them here would be a second place to read the
 * same decision from.
 */

/** The three things a person can be asked to do from the console. */
export type PendingTodoKind = "answer" | "approve" | "choose";

/**
 * The ledger row one todo stands for. It is also the todo's identity: the id
 * is derived from this and nothing else, so the same waiting state yields the
 * same id across processes and across restarts.
 */
export type PendingTodoSource =
  | { readonly kind: "answer"; readonly storyId: string; readonly questionKey: string }
  | {
      readonly kind: "approve";
      readonly scope: "requirement";
      readonly requirementId: string;
      readonly artifact: "prd" | "solution";
    }
  | { readonly kind: "approve"; readonly scope: "epic"; readonly epicId: string }
  | { readonly kind: "choose"; readonly requirementId: string; readonly round: number };

/** `answer:<storyId>:<questionKey>` | `approve:requirement:<id>:prd|solution` |
 *  `approve:epic:<epicId>` | `choose:<requirementId>:<round>`. */
export function pendingTodoId(source: PendingTodoSource): string {
  throw new Error(`pending todo ids are not implemented yet: ${source.kind}`);
}

/** The inverse of `pendingTodoId`, or null for anything that is not one of the
 * three forms. A read of an id this rejects is a todo that does not exist. */
export function parsePendingTodoId(todoId: string): PendingTodoSource | null {
  throw new Error(`pending todo ids are not implemented yet: ${todoId}`);
}

/** The Notion entry a decision has to end up on. */
export interface PendingTodoTarget {
  readonly kind: "requirement" | "epic" | "story";
  readonly id: string;
  readonly title: string;
  readonly pageId: string;
  /** Opened in Notion by the person who wants to read the entry itself. */
  readonly pageUrl: string;
}

/**
 * Where the todo came from, for the line above the question: the Notion entry
 * and the requirement it belongs to. A Story or an Epic reports its
 * requirement, because "which requirement is this about" is the first thing a
 * person asks and it is not on the card's own page.
 */
export interface PendingTodoSubject extends PendingTodoTarget {
  readonly requirementId: string | null;
  readonly requirementTitle: string | null;
}

/** Stable ids for the blocks of text a person reads before deciding. The texts
 * are the ledger's own words; the headings are the console's copy, so a
 * release can reword a heading without a second account of the content. */
export type PendingTodoSectionId =
  | "question"
  | "suggested_answer"
  | "prd_goal"
  | "prd_scenarios"
  | "solution_summary"
  | "solution_alternatives"
  | "approval_reasons"
  | "solution_open_decisions"
  | "plan_summary"
  | "plan_stories";

export interface PendingTodoSection {
  readonly id: PendingTodoSectionId;
  readonly text: string;
}

/** One result a person can pick. `id` is the letter of a clarification option,
 * or `approve` / `rework` for a conclusion. */
export interface PendingTodoOption {
  readonly id: string;
  readonly label: string;
  /** Already approved elsewhere, or the option the agent would pick. Marked,
   * never preselected: a preselected answer is a person agreeing by default. */
  readonly recommended: boolean;
}

export interface PendingTodoQuestion {
  /** 1-based, and the number the reply grammar uses, so what the person picked
   * here means the same thing when the answer is read back. */
  readonly index: number;
  readonly question: string;
  readonly context: string | null;
  /** The answer the agent proposed for a Story question (`open_questions.
   * suggestion`). Shown as a candidate: it is never applied on its own, and
   * the reply box stays empty until a person writes or adopts it. */
  readonly suggestion: string | null;
  readonly options: readonly PendingTodoOption[];
}

/**
 * What is recorded for this todo, if anything.
 *
 * `awaiting_notion` covers both a write still queued and one already sent but
 * not yet recorded: from the person's side both mean "not confirmed retained
 * yet", and the difference is diagnostics, not a decision.
 */
export type TodoDecisionState =
  | { readonly status: "awaiting_notion"; readonly submittedAt: number }
  | {
      readonly status: "retryable";
      readonly submittedAt: number;
      /** Why the write gave up, for the page's technical fold. */
      readonly detail: string;
    }
  | {
      readonly status: "processed";
      readonly submittedAt: number;
      readonly recordedAt: number;
    };

export interface PendingTodoSummary {
  readonly todoId: string;
  readonly kind: PendingTodoKind;
  /** What this todo is about, in the ledger's words: the question asked, the
   * draft's own title, the round's first question. */
  readonly title: string;
  readonly subject: PendingTodoSubject;
  readonly waitingSince: number;
  readonly decision: TodoDecisionState | null;
}

export interface PendingTodoDetail extends PendingTodoSummary {
  /** In reading order. Empty for a todo whose content is a question. */
  readonly sections: readonly PendingTodoSection[];
  /** The questions to answer or pick from. Empty for an approval. */
  readonly questions: readonly PendingTodoQuestion[];
  /** The conclusions an approval offers. Empty for the other two kinds. */
  readonly conclusions: readonly PendingTodoOption[];
  readonly notionTarget: PendingTodoTarget;
}

/** A todo still waiting for a person: the ledger says so and nothing has been
 * decided yet. Oldest first, which is why `firstPendingTodoId` is the head. */
export async function listPendingTodos(client: Client): Promise<readonly PendingTodoSummary[]> {
  throw new Error(`listing pending todos is not implemented yet (${String(client)})`);
}

/**
 * One todo in full, waiting or already decided:
 *
 *  - waiting and undecided        -> the todo as the ledger holds it
 *  - waiting, decision submitted  -> the same, with `decision` set
 *  - already recorded             -> the source no longer waits, but the
 *                                    decision row does, so the page a person
 *                                    submitted on can still say what happened
 *  - never a todo at all          -> null
 */
export async function readPendingTodo(client: Client, todoId: string): Promise<PendingTodoDetail | null> {
  throw new Error(`reading pending todo ${todoId} is not implemented yet`);
}

/** The oldest waiting todo. The todo page opens on it when no id was named,
 * and the empty state is `waiting`'s empty list, never this being null. */
export async function firstPendingTodoId(client: Client): Promise<string | null> {
  throw new Error(`the first pending todo is not implemented yet (${String(client)})`);
}

/** The recorded decision for one todo, without the rest of the projection. */
export async function readTodoDecisionState(
  client: Client,
  todoId: string,
): Promise<TodoDecisionState | null> {
  throw new Error(`reading the decision for ${todoId} is not implemented yet`);
}
