import type { FastifyInstance } from "fastify";

export type OperatorSubjectKind = "requirement" | "epic" | "story";
export type OperatorTodoKind = "reply" | "approval" | "choice";
export type OverviewItemState = "running" | "failed" | "completed";

export interface OperatorSubjectRef {
  kind: OperatorSubjectKind;
  id: string;
  title: string;
  notionPageId: string;
}

export interface TodoOption {
  id: string;
  label: string;
  description?: string;
}

interface TodoBase {
  id: string;
  /** Changes whenever the source action changes or stops waiting. */
  revision: string;
  subject: OperatorSubjectRef;
  question: string;
  context: string;
  sourceLabel: string;
  waitingSince: number;
}

export interface ReplyTodo extends TodoBase {
  kind: "reply";
  answerLabel: string;
}

export interface ApprovalTodo extends TodoBase {
  kind: "approval";
  options: readonly [TodoOption, ...TodoOption[]];
  noteLabel: string;
  noteRequired: boolean;
}

export interface ChoiceTodo extends TodoBase {
  kind: "choice";
  options: readonly [TodoOption, ...TodoOption[]];
}

export type OperatorTodo = ReplyTodo | ApprovalTodo | ChoiceTodo;

export interface TodoSummary {
  id: string;
  revision: string;
  kind: OperatorTodoKind;
  subject: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
  sourceLabel: string;
  waitingSince: number;
}

export interface OverviewItem {
  subject: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
  state: OverviewItemState;
  phase: string | null;
  updatedAt: number;
  currentRound: number | null;
  costUsd: number;
}

export interface OperatorOverview {
  generatedAt: number;
  waitingForOperator: readonly TodoSummary[];
  running: readonly OverviewItem[];
  failures: readonly OverviewItem[];
  recentlyCompleted: readonly OverviewItem[];
}

export type CostLimitState =
  | { kind: "within_limit" }
  | { kind: "exceeded"; workContinues: true };

export interface OperatorRound {
  number: number;
  trigger: string;
  phase: string;
  result: string | null;
  blocker: string | null;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
}

export interface OperatorDetail {
  subject: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
  stateLabel: string;
  currentRound: OperatorRound;
  /** Newest first. The current round is never repeated here. */
  history: readonly OperatorRound[];
  totalCostUsd: number;
  costLimit: CostLimitState;
}

export type OperatorDetailResult =
  | { kind: "available"; detail: OperatorDetail }
  | { kind: "no_rounds"; subject: Pick<OperatorSubjectRef, "kind" | "id" | "title"> };

export type OperatorTodoResult =
  | { kind: "pending"; todo: OperatorTodo }
  | { kind: "unavailable" };

export interface OperatorConsoleReadPort {
  overview(): Promise<OperatorOverview>;
  todo(todoId: string): Promise<OperatorTodoResult>;
  detail(subject: Pick<OperatorSubjectRef, "kind" | "id">): Promise<OperatorDetailResult>;
}

interface TodoSubmissionBase {
  todoId: string;
  expectedRevision: string;
  /** Reused by retries so an uncertain Notion response cannot create two actions. */
  idempotencyKey: string;
}

export type TodoSubmission =
  | (TodoSubmissionBase & { kind: "reply"; text: string })
  | (TodoSubmissionBase & { kind: "approval"; optionId: string; note: string })
  | (TodoSubmissionBase & { kind: "choice"; optionId: string });

export interface SavedTodoResult {
  kind: "saved";
  todoId: string;
  savedAt: number;
  destination: Pick<OperatorSubjectRef, "kind" | "id" | "title">;
}

export type TodoSubmissionResult =
  | SavedTodoResult
  | { kind: "validation_failed"; field: "text" | "option" | "note" }
  | { kind: "submitting"; retryAfterMs: number }
  | { kind: "not_saved"; reason: "notion_rejected" | "confirmation_timeout"; retryable: true }
  | { kind: "unavailable" };

export interface TodoSubmissionLease {
  todoId: string;
  expectedRevision: string;
  idempotencyKey: string;
  /** Monotonic CAS token; an older submitter cannot finish a newer attempt. */
  fence: number;
}

export type TodoSubmissionClaim =
  | { kind: "acquired"; lease: TodoSubmissionLease }
  | { kind: "submitting"; retryAfterMs: number }
  | SavedTodoResult
  | { kind: "unavailable" };

/** Central-store ownership and exclusion for submissions from multiple hosts. */
export interface OperatorTodoSubmissionStore {
  claim(input: TodoSubmission, claimedAt: number): Promise<TodoSubmissionClaim>;
  confirm(lease: TodoSubmissionLease, result: SavedTodoResult): Promise<boolean>;
  fail(
    lease: TodoSubmissionLease,
    reason: "notion_rejected" | "confirmation_timeout",
    failedAt: number,
  ): Promise<boolean>;
}

export type NotionTodoWriteResult =
  | { kind: "confirmed"; confirmedAt: number }
  | { kind: "rejected" }
  | { kind: "confirmation_timeout" };

/** Orchestrator-owned adapter that sends the action through NotionGateway. */
export interface OperatorNotionActionPort {
  saveAndConfirm(input: TodoSubmission, lease: TodoSubmissionLease): Promise<NotionTodoWriteResult>;
}

/**
 * The orchestrator owns this port. Its implementation is the only console path
 * allowed to reach Notion, and must do so through NotionGateway. Completion is
 * published only after the Notion write is confirmed and the central store is
 * updated with the same idempotency key.
 */
export interface OperatorTodoCommandPort {
  submit(input: TodoSubmission): Promise<TodoSubmissionResult>;
}

export type ConsoleAccessDecision =
  | { kind: "allowed" }
  | { kind: "denied" };

/** Fail closed. The address must be the socket peer unless a trusted proxy has
 * already resolved and validated the original client address. */
export interface ConsoleNetworkAccessPort {
  decide(clientAddress: string): ConsoleAccessDecision;
}

export type ConsolePageState<T> =
  | { kind: "loading"; previous?: T }
  | { kind: "ready"; value: T; refreshing: boolean }
  | { kind: "failed"; previous?: T }
  | { kind: "waiting"; value: T; waitingFor: "round_result" | "notion_confirmation"; refreshAfterMs: number };

export interface OperatorConsoleDependencies {
  access: ConsoleNetworkAccessPort;
  reads: OperatorConsoleReadPort;
  commands: OperatorTodoCommandPort;
}

export function renderOperatorAccessPage(): string {
  return "";
}

export function renderOperatorOverviewPage(
  state: ConsolePageState<OperatorOverview>,
  now: number,
): string {
  void state;
  void now;
  return "";
}

export function renderOperatorTodoPage(
  state: ConsolePageState<OperatorTodoResult>,
  options: { submission?: TodoSubmissionResult; submittedValue?: string } = {},
): string {
  void state;
  void options;
  return "";
}

export function renderOperatorDetailPage(
  state: ConsolePageState<OperatorDetailResult>,
  selectedRound?: number,
): string {
  void state;
  void selectedRound;
  return "";
}

/**
 * Registers the access gate, overview, todo and detail HTTP surfaces. The gate
 * must run before every data route and before the application shell is sent;
 * denied requests receive only the access screen and never call another port.
 */
export async function registerOperatorConsoleRoutes(
  app: FastifyInstance,
  dependencies: OperatorConsoleDependencies,
): Promise<void> {
  void app;
  void dependencies;
}
