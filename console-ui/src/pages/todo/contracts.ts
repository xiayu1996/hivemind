/**
 * The todo screen's contract: what it reads, what it may write, the states it
 * can be in, and the words a person reads.
 *
 * The types mirror `src/console/todo-contract.ts` as they cross the wire. They
 * are written out rather than imported because console-ui builds on its own
 * root; the server file is the authority for what a payload means, and a
 * change on either side has to change both.
 *
 * Nothing here is persisted, and nothing here creates work. The screen answers
 * one todo that the ledger already says is waiting: there is no control for
 * creating a requirement, editing a task, or moving work on, because the
 * console offers no such request to call.
 */

import copy from "./copy.json" with { type: "json" };

export type TodoKindDto = "answer" | "approve" | "choose";
export type TodoSubjectKindDto = "requirement" | "epic" | "story";

export interface TodoTargetDto {
  readonly kind: TodoSubjectKindDto;
  readonly id: string;
  readonly title: string;
  readonly pageId: string;
  readonly pageUrl: string;
}

export interface TodoSubjectDto extends TodoTargetDto {
  readonly requirementId: string | null;
  readonly requirementTitle: string | null;
}

export type TodoDecisionStateDto =
  | { readonly status: "awaiting_notion"; readonly submittedAt: number }
  | { readonly status: "retryable"; readonly submittedAt: number; readonly detail: string }
  | { readonly status: "processed"; readonly submittedAt: number; readonly recordedAt: number };

export type TodoSectionIdDto =
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

export interface TodoSectionDto {
  readonly id: TodoSectionIdDto;
  readonly text: string;
}

export interface TodoOptionDto {
  readonly id: string;
  readonly label: string;
  readonly recommended: boolean;
}

export interface TodoQuestionDto {
  readonly index: number;
  readonly question: string;
  readonly context: string | null;
  readonly suggestion: string | null;
  readonly options: readonly TodoOptionDto[];
}

export interface TodoSummaryDto {
  readonly todoId: string;
  readonly kind: TodoKindDto;
  readonly title: string;
  readonly subject: TodoSubjectDto;
  readonly waitingSince: number;
  readonly decision: TodoDecisionStateDto | null;
}

export interface TodoDetailDto extends TodoSummaryDto {
  readonly sections: readonly TodoSectionDto[];
  readonly questions: readonly TodoQuestionDto[];
  readonly conclusions: readonly TodoOptionDto[];
  readonly notionTarget: TodoTargetDto;
}

export interface TodoListDto {
  readonly todos: readonly TodoSummaryDto[];
  readonly openTodoId: string | null;
}

/** What the person's form holds, per kind. The same shape goes back to the
 * server; it never carries an id the server did not give it. */
export type TodoSubmissionDto =
  | { readonly kind: "answer"; readonly answer: string; readonly submittedBy: string }
  | {
      readonly kind: "approve";
      readonly conclusion: "approve" | "rework";
      readonly note: string;
      readonly submittedBy: string;
    }
  | {
      readonly kind: "choose";
      readonly answers: readonly {
        readonly questionIndex: number;
        readonly optionLetter: string | null;
        readonly text: string;
      }[];
      readonly note: string;
      readonly submittedBy: string;
    };

export type TodoValidationIssueDto =
  | "empty_answer"
  | "empty_choice"
  | "unknown_option"
  | "unknown_question"
  | "unknown_conclusion";

export type TodoSubmitResultDto =
  | { readonly kind: "recorded"; readonly state: TodoDecisionStateDto }
  | { readonly kind: "invalid"; readonly issues: readonly TodoValidationIssueDto[] }
  | { readonly kind: "gone" }
  | { readonly kind: "failed" };

export type TodoReadResultDto =
  | { readonly kind: "pending"; readonly todo: TodoDetailDto }
  | { readonly kind: "none" }
  | { readonly kind: "failed" };

/**
 * The one seam where the shell hands the screen its data. A test passes a fake
 * and drives the whole screen without a server.
 *
 * `read(null)` asks for the oldest waiting todo, which is what the empty state
 * is: an empty list, never a screen that could not decide what to show.
 */
export interface TodoPagePort {
  read(todoId: string | null): Promise<TodoReadResultDto>;
  submit(todoId: string, submission: TodoSubmissionDto): Promise<TodoSubmitResultDto>;
  /** "Check the save": re-sends the decision already recorded, unchanged. */
  checkSave(todoId: string): Promise<TodoSubmitResultDto>;
}

export function createTodoHttpPort(fetchImpl: typeof fetch = fetch): TodoPagePort {
  async function readOne(todoId: string): Promise<TodoReadResultDto> {
    const response = await fetchImpl(todoDetailApiPath(todoId));
    // A gone todo is not a failed read: the page says the same thing about it
    // as it does about an empty list, and never invents a handling status.
    if (response.status === 404) return { kind: "none" };
    if (!response.ok) return { kind: "failed" };
    return { kind: "pending", todo: (await response.json()) as TodoDetailDto };
  }

  async function decision(path: string, init: RequestInit): Promise<TodoSubmitResultDto> {
    const response = await fetchImpl(path, init);
    const body = (await response.json().catch(() => null)) as {
      readonly ok?: boolean;
      readonly state?: TodoDecisionStateDto;
      readonly issues?: readonly TodoValidationIssueDto[];
    } | null;
    if (response.status >= 200 && response.status < 300 && body?.ok === true && body.state) {
      return { kind: "recorded", state: body.state };
    }
    if (response.status === 422) return { kind: "invalid", issues: body?.issues ?? [] };
    if (response.status === 404) return { kind: "gone" };
    return { kind: "failed" };
  }

  return {
    async read(todoId) {
      try {
        if (todoId !== null) return await readOne(todoId);
        const response = await fetchImpl(todoListApiPath());
        if (!response.ok) return { kind: "failed" };
        const list = (await response.json()) as TodoListDto;
        return list.openTodoId === null ? { kind: "none" } : await readOne(list.openTodoId);
      } catch {
        // A request that never arrived is a read that failed, not a ledger
        // with nothing in it: the screen must never call the two the same.
        return { kind: "failed" };
      }
    },
    async submit(todoId, submission) {
      try {
        return await decision(todoDecisionApiPath(todoId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(submission),
        });
      } catch {
        return { kind: "failed" };
      }
    },
    async checkSave(todoId) {
      try {
        return await decision(todoSaveCheckApiPath(todoId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      } catch {
        return { kind: "failed" };
      }
    },
  };
}

/** Mirrors `TODO_LIST_PATH`, `TODO_DETAIL_PATH`, `TODO_DECISION_PATH` and
 * `TODO_SAVE_CHECK_PATH` in `src/console/todo-contract.ts`. */
export function todoListApiPath(): string {
  return "/api/todos";
}
export function todoDetailApiPath(todoId: string): string {
  return `/api/todos/${encodeURIComponent(todoId)}`;
}
export function todoDecisionApiPath(todoId: string): string {
  return `/api/todos/${encodeURIComponent(todoId)}/decision`;
}
export function todoSaveCheckApiPath(todoId: string): string {
  return `/api/todos/${encodeURIComponent(todoId)}/save-check`;
}

/**
 * Exactly one of these is current.
 *
 *  - `none`    a read that worked and found nothing waiting: 目前没有待办
 *  - `error`   a read that did not work. It keeps the todo it already had and
 *              shows no handling status at all: a page that cannot read the
 *              todo says so about the read, and never about the work
 *  - `ready`   a todo that is waiting and undecided
 *  - `submitting`  a submission is in flight; the primary action is disabled
 *              so it cannot be triggered twice
 *  - `awaiting_notion` the result is submitted but the Notion entry has not
 *              confirmed it: still 未处理, with 检查保存结果 offered
 *  - `submission_rejected` a submission that did not land (transport failure,
 *              an unexpected response, or a todo reported gone during the
 *              request). The todo, the draft and 未处理 all stay on screen
 *              with 答复未提交，请重试: a failed answer must never read as an
 *              empty ledger
 *  - `processed` the result is confirmed kept: 已处理, and the work continues
 *              from it
 */
export type TodoViewStatus =
  | "idle"
  | "loading"
  | "none"
  | "ready"
  | "error"
  | "submitting"
  | "awaiting_notion"
  | "submission_rejected"
  | "processed";

export interface TodoViewState {
  readonly status: TodoViewStatus;
  readonly todoId: string | null;
  /** Increments per read; a response is applied only when it answers the newest. */
  readonly requestId: number;
  readonly todo: TodoDetailDto | null;
  /** The decision in flight, kept so 检查保存结果 can retry it as it was. */
  readonly submission: TodoSubmissionDto | null;
  readonly issues: readonly TodoValidationIssueDto[];
  readonly decision: TodoDecisionStateDto | null;
}

export type TodoViewAction =
  | { readonly type: "load"; readonly todoId: string | null }
  | { readonly type: "loaded"; readonly requestId: number; readonly result: TodoReadResultDto }
  | { readonly type: "submit"; readonly requestId: number; readonly submission: TodoSubmissionDto }
  | { readonly type: "submitted"; readonly requestId: number; readonly result: TodoSubmitResultDto }
  | { readonly type: "check"; readonly requestId: number };

export function initialTodoView(todoId: string | null): TodoViewState {
  return { status: "idle", todoId, requestId: 0, todo: null, submission: null, issues: [], decision: null };
}
export function reduceTodoView(state: TodoViewState, action: TodoViewAction): TodoViewState {
  switch (action.type) {
    case "load":
      // Content already on screen stays put while the read runs: a refresh that
      // blanks the page makes a person re-read what they were deciding.
      return { ...state, status: "loading", todoId: action.todoId, requestId: state.requestId + 1, issues: [] };
    case "loaded": {
      if (action.requestId < state.requestId) return state;
      if (action.result.kind === "pending") {
        const decision = action.result.todo.decision;
        return {
          ...state,
          requestId: action.requestId,
          todoId: action.result.todo.todoId,
          todo: action.result.todo,
          decision,
          status: decision === null ? "ready" : decision.status === "processed" ? "processed" : "awaiting_notion",
          issues: [],
        };
      }
      if (action.result.kind === "none") {
        return { ...state, requestId: action.requestId, status: "none", todo: null, decision: null, issues: [] };
      }
      return { ...state, requestId: action.requestId, status: "error", issues: [] };
    }
    case "submit":
      return { ...state, status: "submitting", requestId: action.requestId, submission: action.submission, issues: [] };
    case "submitted": {
      if (action.requestId < state.requestId) return state;
      if (action.result.kind === "recorded") {
        return {
          ...state,
          requestId: action.requestId,
          decision: action.result.state,
          status: action.result.state.status === "processed" ? "processed" : "awaiting_notion",
        };
      }
      if (action.result.kind === "invalid") {
        return { ...state, requestId: action.requestId, status: "ready", issues: action.result.issues };
      }
      // A submission that did not land keeps the todo and the draft: gone and
      // failed are both "not submitted", never an empty ledger or a failed
      // read. The person retries the answer they already typed.
      return { ...state, requestId: action.requestId, status: "submission_rejected", issues: [] };
    }
    case "check":
      return { ...state, status: "submitting", requestId: action.requestId, issues: [] };
  }
}

/** An empty form for this todo, of the kind the todo declares. What the person
 * types is added to it; nothing here is preselected, and a todo with a
 * recommended option still opens with nothing chosen. */
export function emptySubmission(todo: TodoDetailDto, submittedBy: string): TodoSubmissionDto {
  if (todo.kind === "answer") return { kind: "answer", answer: "", submittedBy };
  // The approval's conclusion is the screen's own radio state, which starts
  // with nothing chosen; only the free-text note lives in this default.
  if (todo.kind === "approve") return { kind: "approve", conclusion: "approve", note: "", submittedBy };
  return {
    kind: "choose",
    answers: todo.questions.map((question) => ({ questionIndex: question.index, optionLetter: null, text: "" })),
    note: "",
    submittedBy,
  };
}

/** How often the screen reads again while it is open: the requirement's own
 * thirty seconds, and again at once when the page becomes visible. */
export const TODO_REFRESH_INTERVAL_MS = 30_000;

/** 待答复 / 待批准 / 待选择. */
export function todoKindLabel(kind: TodoKindDto): string {
  return copy.kindLabels[kind];
}

/** The heading above one block of ledger text. An unknown id renders no
 * heading rather than the raw id, so a server that learns a new section type
 * cannot leak it into a person's page. */
export function sectionHeading(id: TodoSectionIdDto | string): string {
  return (copy.sectionHeadings as Record<string, string | undefined>)[id] ?? "";
}

/** 等待 18 分钟, from the todo's own `waitingSince`. */
export function formatWaiting(waitingSince: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - waitingSince) / 60_000));
  if (minutes < 60) return `等待 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `等待 ${hours} 小时`;
  return `等待 ${Math.floor(hours / 24)} 天`;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

/** 结果会保留到对应的 Notion 需求“R-…”, the line beside the form that says
 * where the decision goes before the person commits to it. */
export function formatNotionTargetLine(todo: TodoDetailDto): string {
  const destination = copy.destinationValues[todo.notionTarget.kind];
  return `结果会保留到对应的${destination}“${todo.notionTarget.title}”。`;
}

/** 答复已保留到对应的 Notion 任务“…” after a confirmed save. */
export function formatProcessedLine(todo: TodoDetailDto): string {
  return fill(copy.notionTargetTemplate, {
    prefix: copy.savedPrefixes[todo.kind],
    destination: copy.destinationValues[todo.notionTarget.kind],
    title: todo.notionTarget.title,
  });
}

/** The concise confirmed-save status required by the acceptance criteria.
 * It names the destination kind while `formatProcessedLine` retains the fuller
 * entry-specific wording for contexts that need the entry title. */
export function formatSavedConfirmation(todo: TodoDetailDto): string {
  return fill(copy.savedConfirmationTemplate, {
    prefix: copy.savedPrefixes[todo.kind],
    destination: copy.destinationValues[todo.notionTarget.kind],
  });
}

/** The words a validation issue turns into. */
export function validationMessage(issue: TodoValidationIssueDto): string {
  return copy.validation[issue];
}

export const TODO_COPY: {
  readonly heading: string;
  readonly intro: string;
  readonly back: string;
  readonly loading: string;
  readonly loadingBody: string;
  readonly failed: string;
  readonly failedBody: string;
  readonly retry: string;
  readonly none: string;
  readonly noneBody: string;
  readonly gone: string;
  readonly goneBody: string;
  readonly statusUnhandled: string;
  readonly statusProcessed: string;
  readonly decisionHeading: string;
  readonly summaryHeading: string;
  readonly summaryKind: string;
  readonly summaryRequirement: string;
  readonly summaryWaiting: string;
  readonly summaryDestination: string;
  readonly replyLabel: string;
  readonly approveLegend: string;
  readonly choiceLegend: string;
  readonly noteLabel: string;
  readonly noteHelp: string;
  readonly submitting: string;
  readonly answerNotSubmitted: string;
  readonly submissionRejectedBody: string;
  readonly awaitingHeading: string;
  readonly checkSave: string;
  readonly savedPrefixes: { readonly answer: string; readonly approve: string; readonly choose: string };
  readonly conclusionLabels: { readonly approve: string; readonly rework: string };
  readonly conclusionEffects: { readonly approve: string; readonly rework: string };
  readonly submitLabels: { readonly answer: string; readonly approve: string; readonly choose: string };
} = copy;
