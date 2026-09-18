import type { Client } from "@libsql/client";
import { optionLetter, parseQuestions } from "./human-question.js";

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
  switch (source.kind) {
    case "answer":
      return `answer:${source.storyId}:${source.questionKey}`;
    case "approve":
      return source.scope === "requirement"
        ? `approve:requirement:${source.requirementId}:${source.artifact}`
        : `approve:epic:${source.epicId}`;
    case "choose":
      return `choose:${source.requirementId}:${source.round}`;
  }
}

/** The inverse of `pendingTodoId`, or null for anything that is not one of the
 * three forms. A read of an id this rejects is a todo that does not exist. */
export function parsePendingTodoId(todoId: string): PendingTodoSource | null {
  // The approve form is checked first: its "requirement" segment would
  // otherwise be read as an epic id, and the two produce different targets.
  const requirementApproval = /^approve:requirement:([^:]+):(prd|solution)$/.exec(todoId);
  if (requirementApproval) {
    return {
      kind: "approve",
      scope: "requirement",
      requirementId: requirementApproval[1]!,
      artifact: requirementApproval[2] as "prd" | "solution",
    };
  }
  const epicApproval = /^approve:epic:([^:]+)$/.exec(todoId);
  if (epicApproval) return { kind: "approve", scope: "epic", epicId: epicApproval[1]! };
  const answer = /^answer:([^:]+):([^:]+)$/.exec(todoId);
  if (answer) return { kind: "answer", storyId: answer[1]!, questionKey: answer[2]! };
  const choose = /^choose:([^:]+):(\d+)$/.exec(todoId);
  if (choose) return { kind: "choose", requirementId: choose[1]!, round: Number(choose[2]) };
  return null;
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

interface DecisionRow {
  todoId: string;
  submittedAt: number;
  recordedAt: number | null;
  outboxState: string;
  lastError: string | null;
}

function toDecisionState(row: DecisionRow): TodoDecisionState {
  // The ledger's own gate: a decision is made only once its write reached
  // Notion and the record of the person's input exists. Anything else still
  // waits, which is what keeps work from continuing on a decision nothing kept.
  if (row.recordedAt !== null && row.outboxState === "sent") {
    return { status: "processed", submittedAt: row.submittedAt, recordedAt: row.recordedAt };
  }
  if (row.outboxState === "dead") {
    return { status: "retryable", submittedAt: row.submittedAt, detail: row.lastError ?? "" };
  }
  return { status: "awaiting_notion", submittedAt: row.submittedAt };
}

function decisionRow(row: Record<string, unknown>, todoId: string): DecisionRow {
  return {
    todoId,
    submittedAt: Number(row.submitted_at),
    recordedAt: row.recorded_at === null ? null : Number(row.recorded_at),
    outboxState: String(row.outbox_state),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

async function decisionStates(client: Client): Promise<Map<string, TodoDecisionState>> {
  const rows = (await client.execute({
    sql: `SELECT d.todo_id, d.submitted_at, d.recorded_at, o.state AS outbox_state, o.last_error
          FROM todo_decisions d JOIN notion_outbox o ON o.id = d.outbox_id`,
  })).rows;
  const states = new Map<string, TodoDecisionState>();
  for (const row of rows) {
    const todoId = String(row.todo_id);
    states.set(todoId, toDecisionState(decisionRow(row, todoId)));
  }
  return states;
}

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function target(
  kind: PendingTodoTarget["kind"],
  id: string,
  title: string,
  pageId: string,
): PendingTodoTarget {
  return { kind, id, title, pageId, pageUrl: notionPageUrl(pageId) };
}

function subject(
  kind: PendingTodoTarget["kind"],
  id: string,
  title: string,
  pageId: string,
  requirementId: string | null,
  requirementTitle: string | null,
): PendingTodoSubject {
  return { ...target(kind, id, title, pageId), requirementId, requirementTitle };
}

function optionalRowText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** The first question of a clarification round, or empty when it cannot be read:
 * a title is decoration, and one unreadable round must not hide the others. */
function firstClarifyQuestion(questionsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(questionsJson);
    if (!Array.isArray(parsed) || parsed.length === 0) return "";
    const first: unknown = parsed[0];
    if (typeof first === "string") return first;
    return isRecord(first) ? asText(first.question) : "";
  } catch {
    // Only JSON text is ever stored here; a row that is not JSON has no title
    // to offer, which is not a reason to fail the whole waiting list.
    return "";
  }
}

interface AnswerSourceRow {
  todoId: string;
  title: string;
  subject: PendingTodoSubject;
  waitingSince: number;
  question: string;
  suggestion: string;
}

async function answerSources(client: Client): Promise<AnswerSourceRow[]> {
  const rows = (await client.execute({
    sql: `SELECT s.id AS story_id, s.notion_page_id AS page_id, s.title AS story_title,
                 q.question_key, q.question, q.suggestion, q.created_at AS waiting_since,
                 e.requirement_id AS requirement_id, r.title AS requirement_title
          FROM open_questions q
          JOIN stories s ON s.id = q.card_id
          LEFT JOIN epics e ON e.id = s.epic_id
          LEFT JOIN requirements r ON r.id = e.requirement_id
          WHERE s.state = 'NEEDS_INPUT' AND s.stop_reason = 'blocking_question'
            AND q.blocking = 1 AND q.answer IS NULL`,
  })).rows;
  return rows.map((row) => {
    const storyId = String(row.story_id);
    const pageId = String(row.page_id);
    const question = String(row.question);
    return {
      todoId: pendingTodoId({ kind: "answer", storyId, questionKey: String(row.question_key) }),
      title: question,
      subject: subject("story", storyId, String(row.story_title), pageId, optionalRowText(row.requirement_id), optionalRowText(row.requirement_title)),
      waitingSince: Number(row.waiting_since),
      question,
      suggestion: String(row.suggestion ?? ""),
    };
  });
}

interface RequirementApprovalRow {
  todoId: string;
  title: string;
  subject: PendingTodoSubject;
  target: PendingTodoTarget;
  waitingSince: number;
}

async function requirementApprovalSources(
  client: Client,
  artifact: "prd" | "solution",
): Promise<RequirementApprovalRow[]> {
  const table = artifact === "prd" ? "requirement_prds" : "requirement_solutions";
  const state = artifact === "prd" ? "PRD_CONFIRM" : "SOLUTION";
  const rows = (await client.execute({
    sql: `SELECT r.id AS requirement_id, r.notion_page_id AS page_id, r.title,
                 p.created_at AS waiting_since
          FROM requirements r
          JOIN ${table} p ON p.requirement_id = r.id
          WHERE r.state = ? AND p.status = 'draft'
            AND p.revision = (SELECT MAX(revision) FROM ${table} x WHERE x.requirement_id = r.id)`,
    args: [state],
  })).rows;
  return rows.map((row) => {
    const requirementId = String(row.requirement_id);
    const pageId = String(row.page_id);
    const title = String(row.title);
    const requirementTarget = target("requirement", requirementId, title, pageId);
    return {
      todoId: pendingTodoId({ kind: "approve", scope: "requirement", requirementId, artifact }),
      title,
      subject: { ...requirementTarget, requirementId, requirementTitle: title },
      target: requirementTarget,
      waitingSince: Number(row.waiting_since),
    };
  });
}

async function epicApprovalSources(client: Client): Promise<RequirementApprovalRow[]> {
  const rows = (await client.execute({
    sql: `SELECT e.id AS epic_id, e.notion_page_id AS page_id, e.title,
                 e.requirement_id, r.title AS requirement_title, p.created_at AS waiting_since
          FROM epics e
          JOIN epic_plans p ON p.epic_id = e.id
          LEFT JOIN requirements r ON r.id = e.requirement_id
          WHERE e.state = 'PLAN_APPROVAL'`,
  })).rows;
  return rows.map((row) => {
    const epicId = String(row.epic_id);
    const pageId = String(row.page_id);
    const title = String(row.title);
    const epicTarget = target("epic", epicId, title, pageId);
    return {
      todoId: pendingTodoId({ kind: "approve", scope: "epic", epicId }),
      title,
      subject: { ...epicTarget, requirementId: optionalRowText(row.requirement_id), requirementTitle: optionalRowText(row.requirement_title) },
      target: epicTarget,
      waitingSince: Number(row.waiting_since),
    };
  });
}

interface ChoiceSourceRow {
  todoId: string;
  title: string;
  subject: PendingTodoSubject;
  waitingSince: number;
}

async function choiceSources(client: Client): Promise<ChoiceSourceRow[]> {
  const rows = (await client.execute({
    sql: `SELECT r.id AS requirement_id, r.notion_page_id AS page_id, r.title,
                 c.round, c.questions, c.asked_at AS waiting_since
          FROM requirements r
          JOIN requirement_clarify_rounds c ON c.requirement_id = r.id
          WHERE r.state = 'CLARIFY' AND c.answered_at IS NULL
            AND c.round = (SELECT MAX(round) FROM requirement_clarify_rounds x WHERE x.requirement_id = r.id)`,
  })).rows;
  return rows.map((row) => {
    const requirementId = String(row.requirement_id);
    const pageId = String(row.page_id);
    const title = String(row.title);
    return {
      todoId: pendingTodoId({ kind: "choose", requirementId, round: Number(row.round) }),
      title: firstClarifyQuestion(String(row.questions)),
      subject: subject("requirement", requirementId, title, pageId, requirementId, title),
      waitingSince: Number(row.waiting_since),
    };
  });
}

/** A todo still waiting for a person: the ledger says so and nothing has been
 * decided yet. Oldest first, which is why `firstPendingTodoId` is the head. */
export async function listPendingTodos(client: Client): Promise<readonly PendingTodoSummary[]> {
  const [answers, prdApprovals, solutionApprovals, epicApprovals, choices, decisions] = await Promise.all([
    answerSources(client),
    requirementApprovalSources(client, "prd"),
    requirementApprovalSources(client, "solution"),
    epicApprovalSources(client),
    choiceSources(client),
    decisionStates(client),
  ]);

  const summaries: PendingTodoSummary[] = [];
  const push = (kind: PendingTodoKind, entry: { todoId: string; title: string; subject: PendingTodoSubject; waitingSince: number }): void => {
    const decision = decisions.get(entry.todoId) ?? null;
    // A recorded decision is the one thing that removes a todo: the source may
    // still read as waiting until the lanes that own it act, and work that was
    // kept must not be asked for a second time.
    if (decision?.status === "processed") return;
    summaries.push({ todoId: entry.todoId, kind, title: entry.title, subject: entry.subject, waitingSince: entry.waitingSince, decision });
  };

  for (const entry of answers) push("answer", entry);
  for (const entry of prdApprovals) push("approve", entry);
  for (const entry of solutionApprovals) push("approve", entry);
  for (const entry of epicApprovals) push("approve", entry);
  for (const entry of choices) push("choose", entry);

  return summaries.toSorted((a, b) => a.waitingSince - b.waitingSince || a.todoId.localeCompare(b.todoId, "en"));
}

function prdSections(body: string): PendingTodoSection[] {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) return [];
  const sections: PendingTodoSection[] = [];
  const goal = asText(parsed.businessGoal).trim();
  if (goal !== "") sections.push({ id: "prd_goal", text: goal });
  const scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios : [];
  const lines = scenarios.filter(isRecord).map((scenario) => {
    const id = asText(scenario.id);
    const given = asText(scenario.given);
    const when = asText(scenario.when);
    const then = asText(scenario.then);
    return `${id === "" ? "-" : id}: Given ${given}; when ${when}; then ${then}`;
  });
  if (lines.length > 0) sections.push({ id: "prd_scenarios", text: lines.join("\n") });
  return sections;
}

function solutionSections(body: string): PendingTodoSection[] {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) return [];
  const sections: PendingTodoSection[] = [];
  const approach = isRecord(parsed.approach) ? parsed.approach : {};
  const summary = asText(approach.summary).trim();
  if (summary !== "") sections.push({ id: "solution_summary", text: summary });
  const alternatives = Array.isArray(approach.alternatives) ? approach.alternatives : [];
  const alternativeLines = alternatives.filter(isRecord).map((entry) => `${asText(entry.option)}: ${asText(entry.reason)}`);
  if (alternativeLines.length > 0) sections.push({ id: "solution_alternatives", text: alternativeLines.join("\n") });
  const stackChanges = Array.isArray(parsed.stackChanges) ? parsed.stackChanges : [];
  const stackLines = stackChanges.filter(isRecord).map((change) => `${asText(change.name)}: ${asText(change.reason)}`);
  if (stackLines.length > 0) sections.push({ id: "approval_reasons", text: stackLines.join("\n") });
  const openDecisions = Array.isArray(parsed.openDecisions) ? parsed.openDecisions : [];
  const decisionLines = openDecisions.filter(isRecord).map((decision) => `${asText(decision.question)} (suggested: ${asText(decision.recommendation)})`);
  if (decisionLines.length > 0) sections.push({ id: "solution_open_decisions", text: decisionLines.join("\n") });
  return sections;
}

function planSections(body: string): PendingTodoSection[] {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) return [];
  const sections: PendingTodoSection[] = [];
  const goal = asText(parsed.businessGoal).trim();
  if (goal !== "") sections.push({ id: "plan_summary", text: goal });
  const stories = Array.isArray(parsed.stories) ? parsed.stories : [];
  const lines = stories.filter(isRecord).map((story) => `${asText(story.id)}: ${asText(story.title)}`);
  if (lines.length > 0) sections.push({ id: "plan_stories", text: lines.join("\n") });
  return sections;
}

function chooseQuestions(questionsJson: string): PendingTodoQuestion[] {
  return parseQuestions(questionsJson, "clarification round questions").map((question, index) => ({
    index: index + 1,
    question: question.question,
    context: question.context ?? null,
    suggestion: null,
    options: question.options.map((option, optionIndex) => ({
      id: optionLetter(optionIndex),
      label: option.label,
      recommended: option.recommended === true,
    })),
  }));
}

const APPROVAL_CONCLUSIONS: readonly PendingTodoOption[] = [
  { id: "approve", label: "", recommended: false },
  { id: "rework", label: "", recommended: false },
];

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
  const source = parsePendingTodoId(todoId);
  if (!source) return null;
  const [waiting, decision] = await Promise.all([listPendingTodos(client), readTodoDecisionState(client, todoId)]);
  // A source that stopped waiting with nothing decided is a todo that is gone;
  // one with a decision keeps its page, because the person who submitted on it
  // has to be able to read what happened.
  if (decision === null && !waiting.some((todo) => todo.todoId === todoId)) return null;

  if (source.kind === "answer") {
    const row = (await client.execute({
      sql: `SELECT s.id AS story_id, s.notion_page_id AS page_id, s.title AS story_title,
                   q.question, q.suggestion, q.created_at AS waiting_since,
                   e.requirement_id AS requirement_id, r.title AS requirement_title
            FROM stories s
            JOIN open_questions q ON q.card_id = s.id AND q.question_key = ?
            LEFT JOIN epics e ON e.id = s.epic_id
            LEFT JOIN requirements r ON r.id = e.requirement_id
            WHERE s.id = ?`,
      args: [source.questionKey, source.storyId],
    })).rows[0];
    if (!row) return null;
    const storyId = String(row.story_id);
    const pageId = String(row.page_id);
    const storyTarget = target("story", storyId, String(row.story_title), pageId);
    return {
      todoId,
      kind: "answer",
      title: String(row.question),
      subject: { ...storyTarget, requirementId: optionalRowText(row.requirement_id), requirementTitle: optionalRowText(row.requirement_title) },
      waitingSince: Number(row.waiting_since),
      decision,
      sections: [],
      questions: [{
        index: 1,
        question: String(row.question),
        context: null,
        suggestion: String(row.suggestion ?? ""),
        options: [],
      }],
      conclusions: [],
      notionTarget: storyTarget,
    };
  }

  if (source.kind === "approve" && source.scope === "requirement") {
    const table = source.artifact === "prd" ? "requirement_prds" : "requirement_solutions";
    const row = (await client.execute({
      sql: `SELECT r.id AS requirement_id, r.notion_page_id AS page_id, r.title, p.body, p.created_at AS waiting_since
            FROM requirements r
            JOIN ${table} p ON p.requirement_id = r.id
            WHERE r.id = ? AND p.revision = (SELECT MAX(revision) FROM ${table} x WHERE x.requirement_id = r.id)`,
      args: [source.requirementId],
    })).rows[0];
    if (!row) return null;
    const requirementId = String(row.requirement_id);
    const pageId = String(row.page_id);
    const title = String(row.title);
    const requirementTarget = target("requirement", requirementId, title, pageId);
    return {
      todoId,
      kind: "approve",
      title,
      subject: { ...requirementTarget, requirementId, requirementTitle: title },
      waitingSince: Number(row.waiting_since),
      decision,
      sections: source.artifact === "prd" ? prdSections(String(row.body)) : solutionSections(String(row.body)),
      questions: [],
      conclusions: APPROVAL_CONCLUSIONS,
      notionTarget: requirementTarget,
    };
  }

  if (source.kind === "approve" && source.scope === "epic") {
    const row = (await client.execute({
      sql: `SELECT e.id AS epic_id, e.notion_page_id AS page_id, e.title, e.requirement_id,
                   r.title AS requirement_title, p.body, p.created_at AS waiting_since
            FROM epics e
            JOIN epic_plans p ON p.epic_id = e.id
            LEFT JOIN requirements r ON r.id = e.requirement_id
            WHERE e.id = ?`,
      args: [source.epicId],
    })).rows[0];
    if (!row) return null;
    const epicId = String(row.epic_id);
    const pageId = String(row.page_id);
    const title = String(row.title);
    const epicTarget = target("epic", epicId, title, pageId);
    return {
      todoId,
      kind: "approve",
      title,
      subject: { ...epicTarget, requirementId: optionalRowText(row.requirement_id), requirementTitle: optionalRowText(row.requirement_title) },
      waitingSince: Number(row.waiting_since),
      decision,
      sections: planSections(String(row.body)),
      questions: [],
      conclusions: APPROVAL_CONCLUSIONS,
      notionTarget: epicTarget,
    };
  }

  if (source.kind === "choose") {
    const row = (await client.execute({
      sql: `SELECT r.id AS requirement_id, r.notion_page_id AS page_id, r.title, c.questions, c.asked_at AS waiting_since
            FROM requirements r
            JOIN requirement_clarify_rounds c ON c.requirement_id = r.id
            WHERE r.id = ? AND c.round = ?`,
      args: [source.requirementId, source.round],
    })).rows[0];
    if (!row) return null;
    const requirementId = String(row.requirement_id);
    const pageId = String(row.page_id);
    const title = String(row.title);
    const questions = chooseQuestions(String(row.questions));
    return {
      todoId,
      kind: "choose",
      title: questions[0]?.question ?? title,
      subject: subject("requirement", requirementId, title, pageId, requirementId, title),
      waitingSince: Number(row.waiting_since),
      decision,
      sections: [],
      questions,
      conclusions: [],
      notionTarget: target("requirement", requirementId, title, pageId),
    };
  }

  return null;
}

/** The oldest waiting todo. The todo page opens on it when no id was named,
 * and the empty state is `waiting`'s empty list, never this being null. */
export async function firstPendingTodoId(client: Client): Promise<string | null> {
  return (await listPendingTodos(client))[0]?.todoId ?? null;
}

/** The recorded decision for one todo, without the rest of the projection. */
export async function readTodoDecisionState(
  client: Client,
  todoId: string,
): Promise<TodoDecisionState | null> {
  const row = (await client.execute({
    sql: `SELECT d.submitted_at, d.recorded_at, o.state AS outbox_state, o.last_error
          FROM todo_decisions d JOIN notion_outbox o ON o.id = d.outbox_id
          WHERE d.todo_id = ?`,
    args: [todoId],
  })).rows[0];
  if (!row) return null;
  return toDecisionState(decisionRow(row, todoId));
}
