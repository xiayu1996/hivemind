import type { Client } from "@libsql/client";

export declare const OVERVIEW_ENDPOINT: "/api/overview";

export type OverviewItemType = "requirement" | "task";
export type OverviewTodoKind = "reply" | "approval" | "choice";

export type OverviewStage =
  | "CLARIFY"
  | "PRD_CONFIRM"
  | "SOLUTION"
  | "DECOMPOSING"
  | "EXECUTING"
  | "ACCEPTANCE"
  | "QUEUED"
  | "SHAPE"
  | "DESIGN"
  | "SPECIFY"
  | "CODE"
  | "VERIFY"
  | "MERGE"
  | "REGRESSION_FIX";

export interface OverviewTimeRange {
  startInclusiveMs: number;
  endInclusiveMs: number;
  timeZone: string;
}

export interface OverviewAction {
  label: string;
  href: string;
}

export interface OverviewTodoItem {
  id: string;
  kind: OverviewTodoKind;
  title: string;
  requirement: { id: string; title: string };
  waitingSinceMs: number;
  action: OverviewAction;
}

export interface OverviewActiveItem {
  id: string;
  type: OverviewItemType;
  name: string;
  stage: OverviewStage;
  status: "running";
  changedAtMs: number;
  detailHref: string;
}

export interface OverviewFailureItem {
  id: string;
  type: OverviewItemType;
  name: string;
  stage: OverviewStage;
  status: "failed";
  reason: string;
  failedAtMs: number;
  detailHref: string;
}

export interface OverviewCompletedItem {
  id: string;
  type: OverviewItemType;
  name: string;
  status: "completed";
  completedAtMs: number;
  detailHref: string;
}

export interface OverviewCostOverrun {
  requirementId: string;
  requirementName: string;
  spentUsd: number;
  limitUsd: number;
  status: "over_limit";
  workContinues: true;
  costsHref: string;
}

export interface OverviewSummary {
  range: OverviewTimeRange;
  completedCount: number;
  runningCount: number;
  failureCount: number;
  costUsd: number;
  overruns: OverviewCostOverrun[];
}

export interface OverviewSections {
  todos: OverviewTodoItem[];
  active: OverviewActiveItem[];
  failures: OverviewFailureItem[];
  completed: OverviewCompletedItem[];
}

export type OverviewContentState =
  | { kind: "ready" }
  | { kind: "empty" }
  | { kind: "waiting"; result: string; refreshByMs: number };

export interface OverviewSnapshot {
  revision: string;
  generatedAtMs: number;
  contentState: OverviewContentState;
  sections: OverviewSections;
  summary: OverviewSummary;
}

export interface OverviewReadQuery {
  nowMs: number;
  timeZone: string;
}

/**
 * Reads one snapshot from the central store. The reader owns classification,
 * deduplication, seven-day boundaries, totals and stable sort order. All rows
 * belong to one read transaction so an item cannot appear in two sections
 * while a concurrent state transition commits.
 */
export interface OverviewReadPort {
  readOverview(query: OverviewReadQuery): Promise<OverviewSnapshot>;
}

export declare function createLibsqlOverviewReader(client: Client): OverviewReadPort;

export type OverviewViewState =
  | { kind: "loading"; scope: "todos_active_failures_completed_7d" }
  | { kind: "content"; snapshot: OverviewSnapshot; refreshing: boolean }
  | { kind: "error"; previous?: OverviewSnapshot; retryable: true };

export interface OverviewSnapshotTransport {
  fetchOverview(input: { timeZone: string; signal: AbortSignal }): Promise<OverviewSnapshot>;
}

export interface OverviewRefreshController {
  current(): OverviewViewState;
  subscribe(listener: (state: OverviewViewState) => void): () => void;
  start(): void;
  stop(): void;
  retry(): void;
  visibilityChanged(visible: boolean): void;
}

/**
 * The controller owns at most one request at a time. A timer refreshes visible
 * pages no later than the interval, visibility restoration refreshes
 * immediately, and stale responses never replace a newer revision. Existing
 * content remains published with refreshing=true until replacement succeeds.
 */
export declare function createOverviewRefreshController(input: {
  transport: OverviewSnapshotTransport;
  timeZone: string;
  refreshIntervalMs: 30000;
  schedule: (delayMs: number, task: () => void) => unknown;
  cancel: (handle: unknown) => void;
}): OverviewRefreshController;
