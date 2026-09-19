import type {
  PendingTodoDetail,
  PendingTodoSummary,
  TodoDecisionState,
} from "../orchestrator/pending-todo.js";
import type {
  TodoSubmission,
  TodoSubmitOutcome,
  TodoValidationIssue,
} from "../orchestrator/todo-decision.js";

/**
 * The console's todo surface: the two reads, the two writes, and the check
 * that keeps every other write out.
 *
 * Reads are the ledger's account of what waits (`pending-todo.ts`); the writes
 * are the only two requests this console accepts besides the config write that
 * already existed. Neither of them can create a requirement, edit a task or
 * move work on: they name a todo that is already waiting and answer it.
 *
 * The page a person reads is served by the shell; everything here is JSON, and
 * the console-ui copy of these payloads lives in
 * `console-ui/src/pages/todo/contracts.ts`.
 */

export const TODO_LIST_PATH = "/api/todos";
export const TODO_DETAIL_PATH = "/api/todos/:todoId";
export const TODO_DECISION_PATH = "/api/todos/:todoId/decision";
export const TODO_SAVE_CHECK_PATH = "/api/todos/:todoId/save-check";

export function todoDetailPath(todoId: string): string {
  return `/api/todos/${encodeURIComponent(todoId)}`;
}
export function todoDecisionPath(todoId: string): string {
  return `/api/todos/${encodeURIComponent(todoId)}/decision`;
}
export function todoSaveCheckPath(todoId: string): string {
  return `/api/todos/${encodeURIComponent(todoId)}/save-check`;
}

/**
 * The complete list of write routes the console offers. Anything else that is
 * not a read is refused before it reaches a handler.
 *
 * The reason this is a list and not a rule ("todos may be written") is that a
 * rule would admit whatever the next person bolts onto the todo path; the
 * acceptance of this requirement is precisely that no other write exists, and
 * that has to be checkable by reading one line.
 */
export const CONSOLE_WRITE_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  { method: "POST", path: "/api/config/value" },
  { method: "POST", path: "/api/config/rollback" },
  { method: "POST", path: "/costs/requirement-limit" },
  { method: "POST", path: TODO_DECISION_PATH },
  { method: "POST", path: TODO_SAVE_CHECK_PATH },
];

/** True when this request is one of the write routes above. The console's
 * request hook uses it; a POST to anything else is refused with 405.
 *
 * A route whose path holds a `:name` segment matches exactly one path segment
 * there, and nothing else: `/api/todos/../config/value` and
 * `/api/todos/a/b/decision` are not the todo route, and the query string is
 * not part of the path. */
export function isConsoleWriteRequest(method: string, path: string): boolean {
  return matchedConsoleWriteRoute(method, path) !== null;
}

/**
 * Which declared route this request is, by its declared path rather than the
 * requested one, or null when it is none of them.
 *
 * The caller needs the declaration and not just a yes: each route is answered
 * by its own port, and a route whose port was not handed over is refused the
 * same as one that was never declared.
 */
export function matchedConsoleWriteRoute(method: string, path: string): string | null {
  if (method !== "POST") return null;
  const segments = (path.split("?")[0] ?? "").split("/");
  return CONSOLE_WRITE_ROUTES.find((route) => {
    if (route.method !== method) return false;
    const expected = route.path.split("/");
    if (expected.length !== segments.length) return false;
    return expected.every((segment, index) => {
      // A `:name` segment stands for exactly one non-empty segment. Anything
      // longer or shorter is a different route, which is what keeps
      // `/api/todos/a/b/decision` and `/api/todos/../config/value` out.
      if (segment.startsWith(":")) return (segments[index] ?? "") !== "";
      return segment === segments[index];
    });
  })?.path ?? null;
}

/** The todo list, oldest waiting first, plus the id the page opens on when no
 * id was named. `openTodoId` is null exactly when the list is empty, and that
 * is the empty state a person sees -- never a list that failed to load. */
export interface TodoListPayload {
  readonly todos: readonly PendingTodoSummary[];
  readonly openTodoId: string | null;
}

export type TodoDetailPayload = PendingTodoDetail;

/**
 * What a write answers. HTTP status carries the outcome, and the body carries
 * the state the page renders next:
 *
 *   200 accepted  -> the decision state (processed, awaiting_notion, retryable)
 *   404 gone      -> the todo no longer waits and has no recorded decision
 *   422 invalid   -> validation issues, as codes
 *   405           -> any write that is not one of the routes above
 *
 * 409 is deliberately not used: a second submit for a todo that already has a
 * decision is the same person asking twice, and the answer is the decision
 * already recorded rather than a refusal.
 */
export type TodoDecisionResponse =
  | { readonly ok: true; readonly state: TodoDecisionState }
  | { readonly ok: false; readonly reason: "gone" }
  | { readonly ok: false; readonly reason: "invalid"; readonly issues: readonly TodoValidationIssue[] };

/** Reads of the ledger side. Implemented by the libsql data source. */
export interface ConsoleTodoReadPort {
  listTodos(): Promise<TodoListPayload>;
  /** Null when the id is not a todo at all (404 for the page). */
  readTodo(todoId: string): Promise<TodoDetailPayload | null>;
}

/** The one write port. Absent, the console serves the todo page read-only. */
export interface ConsoleTodoCommandPort {
  submit(todoId: string, submission: TodoSubmission): Promise<TodoSubmitOutcome>;
  recheck(todoId: string): Promise<TodoDecisionState | null>;
}
