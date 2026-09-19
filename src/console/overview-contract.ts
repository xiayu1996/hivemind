import type { Client, Row, Transaction } from "@libsql/client";
import text from "./overview-text.json" with { type: "json" };

export const OVERVIEW_ENDPOINT = "/api/overview" as const;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TODOS_SCOPE = "todos_active_failures_completed_7d" as const;

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
  /** The question a person has to settle, when the todo carries one. */
  question: string;
  /** The choices a `choice` todo offers; empty for a free-form reply. */
  options: string[];
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
  /** Requirements whose spend inside the summary window is over the ceiling. */
  overruns: OverviewCostOverrun[];
  /** Requirements whose whole spend is over the ceiling. A ceiling caps the
   * requirement rather than one week of it, so this is the list the overview
   * shows beside a requirement's name; the seven-day `overruns` above answers
   * only what the summary window alone contains. */
  lifetimeOverruns?: OverviewCostOverrun[];
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

/** Requirement states that mean the workflow is still moving on its own. A
 * person waiting on a question or an approval keeps the requirement in one of
 * these, so the open-todo read is what removes it from the running section. */
const RUNNING_REQUIREMENT_STATES = new Set([
  "CLARIFY",
  "PRD_CONFIRM",
  "SOLUTION",
  "DECOMPOSING",
  "EXECUTING",
  "ACCEPTANCE",
]);

const RUNNING_STORY_STATES = new Set([
  "QUEUED",
  "SHAPE",
  "DESIGN",
  "SPECIFY",
  "CODE",
  "VERIFY",
  "MERGE",
  "REGRESSION_FIX",
]);

interface RequirementRow {
  id: string;
  title: string;
  state: string;
  updatedAt: number;
}

interface StoryRow {
  id: string;
  title: string;
  state: string;
  phase: string | null;
  updatedAt: number;
}

function asStage(value: string): OverviewStage {
  return value as OverviewStage;
}

function numberValue(value: unknown): number {
  return Number(value);
}

function detailHref(id: string): string {
  return `/detail/${encodeURIComponent(id)}`;
}

function todoHref(requirementId: string): string {
  return `/todo?requirement=${encodeURIComponent(requirementId)}`;
}

function costsHref(requirementId: string): string {
  return `/costs?requirement=${encodeURIComponent(requirementId)}`;
}

/** The first question a clarify round asked, with the labels it offered. The
 * questions column is opaque JSON, so anything unreadable reads as no question
 * rather than as a reason the whole read fails. */
function questionParts(questions: unknown): { question: string; options: string[] } {
  if (!Array.isArray(questions)) return { question: "", options: [] };
  for (const entry of questions) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { question?: unknown; options?: unknown };
    const question = typeof candidate.question === "string" ? candidate.question : "";
    const options = Array.isArray(candidate.options)
      ? candidate.options
        .map((option) => {
          if (typeof option === "string") return option;
          if (typeof option === "object" && option !== null) {
            const label = (option as { label?: unknown }).label;
            if (typeof label === "string") return label;
          }
          return "";
        })
        .filter((label) => label.length > 0)
      : [];
    if (question !== "" || options.length > 0) return { question, options };
  }
  return { question: "", options: [] };
}

interface OverviewRows {
  requirements: RequirementRow[];
  stories: StoryRow[];
  clarifyTodos: OverviewTodoItem[];
  prdTodos: OverviewTodoItem[];
  solutionTodos: OverviewTodoItem[];
  failureEvents: Array<{ cardId: string; ts: number; data: unknown }>;
  failedRuns: Array<{ cardId: string; phase: string; failure: string | null; endedAt: number | null }>;
  costs: Array<{ cardId: string | null; usd: number }>;
  lifetimeCosts: Array<{ cardId: string | null; usd: number }>;
  storyRequirement: Map<string, string>;
  epicRequirement: Map<string, string>;
  ceilingUsd: number;
}

async function readRows(tx: Transaction, rangeStart: number, nowMs: number): Promise<OverviewRows> {
  const results = await tx.batch([
    "SELECT id, title, state, updated_at FROM requirements",
    "SELECT id, title, state, phase, updated_at FROM stories",
    `SELECT c.requirement_id, c.round, c.questions, c.asked_at, r.title, r.state
       FROM requirement_clarify_rounds c JOIN requirements r ON r.id = c.requirement_id
      WHERE c.answered_at IS NULL`,
    `SELECT p.requirement_id, p.revision, p.created_at, r.title
       FROM requirement_prds p JOIN requirements r ON r.id = p.requirement_id
      WHERE p.status = 'draft'`,
    `SELECT s.requirement_id, s.revision, s.created_at, r.title
       FROM requirement_solutions s JOIN requirements r ON r.id = s.requirement_id
      WHERE s.status = 'draft'`,
    `SELECT card_id, ts, data FROM event_log
      WHERE type = 'requirement.transition'
        AND card_id IN (SELECT id FROM requirements WHERE state = 'FAILED')
      ORDER BY id`,
    `SELECT card_id, phase, failure, ended_at FROM phase_runs
      WHERE status = 'failed' AND card_id IN (SELECT id FROM stories WHERE state = 'FAILED')
      ORDER BY ended_at`,
    { sql: "SELECT card_id, SUM(cost_usd) AS usd FROM cost_entries WHERE ts >= ? AND ts <= ? GROUP BY card_id", args: [rangeStart, nowMs] },
    "SELECT card_id, SUM(cost_usd) AS usd FROM cost_entries GROUP BY card_id",
    "SELECT s.id AS story_id, e.requirement_id FROM stories s JOIN epics e ON e.id = s.epic_id WHERE e.requirement_id IS NOT NULL",
    "SELECT e.id, e.requirement_id FROM epics e WHERE e.requirement_id IS NOT NULL",
    "SELECT value_json FROM config_entries WHERE scope_id = 'global' AND key = 'cost.perCardUsdCeiling'",
  ]);

  const [requirementRows, storyRows, clarifyRows, prdRows, solutionRows, failureEventRows, failedRunRows, costRows, lifetimeCostRows, storyEpicRows, epicRows, ceilingRows] =
    results;

  const requirements: RequirementRow[] = (requirementRows?.rows ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    state: String(row.state),
    updatedAt: numberValue(row.updated_at),
  }));
  const requirementTitle = new Map(requirements.map((row) => [row.id, row.title]));

  const stories: StoryRow[] = (storyRows?.rows ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    state: String(row.state),
    phase: row.phase === null ? null : String(row.phase),
    updatedAt: numberValue(row.updated_at),
  }));

  const clarifyTodos: OverviewTodoItem[] = [];
  for (const row of clarifyRows?.rows ?? []) {
    const requirementId = String(row.requirement_id);
    if (row.state === "DONE" || row.state === "FAILED") continue;
    const title = String(row.title);
    const parts = questionParts(JSON.parse(String(row.questions)));
    clarifyTodos.push({
      id: `clarify:${requirementId}:${numberValue(row.round)}`,
      kind: parts.options.length > 0 ? "choice" : "reply",
      title,
      requirement: { id: requirementId, title },
      waitingSinceMs: numberValue(row.asked_at),
      question: parts.question,
      options: parts.options,
      action: { label: text.todoActionLabel, href: todoHref(requirementId) },
    });
  }

  const prdTodos = draftTodos(prdRows?.rows ?? [], requirementTitle, "prd");
  const solutionTodos = draftTodos(solutionRows?.rows ?? [], requirementTitle, "solution");

  const failureEvents = (failureEventRows?.rows ?? []).map((row) => ({
    cardId: String(row.card_id),
    ts: numberValue(row.ts),
    data: JSON.parse(String(row.data)) as unknown,
  }));

  const failedRuns = (failedRunRows?.rows ?? []).map((row) => ({
    cardId: String(row.card_id),
    phase: String(row.phase),
    failure: row.failure === null ? null : String(row.failure),
    endedAt: row.ended_at === null ? null : numberValue(row.ended_at),
  }));

  const costs = (costRows?.rows ?? []).map((row) => ({
    cardId: row.card_id === null ? null : String(row.card_id),
    usd: numberValue(row.usd),
  }));
  const lifetimeCosts = (lifetimeCostRows?.rows ?? []).map((row) => ({
    cardId: row.card_id === null ? null : String(row.card_id),
    usd: numberValue(row.usd),
  }));

  const storyRequirement = new Map<string, string>();
  for (const row of storyEpicRows?.rows ?? []) {
    storyRequirement.set(String(row.story_id), String(row.requirement_id));
  }
  const epicRequirement = new Map<string, string>();
  for (const row of epicRows?.rows ?? []) {
    epicRequirement.set(String(row.id), String(row.requirement_id));
  }

  const ceilingRow = ceilingRows?.rows[0];
  const ceilingUsd = ceilingRow ? numberValue(JSON.parse(String(ceilingRow.value_json))) : 5;

  return {
    requirements,
    stories,
    clarifyTodos,
    prdTodos,
    solutionTodos,
    failureEvents,
    failedRuns,
    costs,
    lifetimeCosts,
    storyRequirement,
    epicRequirement,
    ceilingUsd,
  };
}

/** One draft per requirement: the revision that is up for a person to read. */
function draftTodos(
  rows: Row[],
  requirementTitle: Map<string, string>,
  source: "prd" | "solution",
): OverviewTodoItem[] {
  const latest = new Map<string, { revision: number; createdAt: number }>();
  for (const row of rows) {
    const requirementId = String(row.requirement_id);
    const revision = numberValue(row.revision);
    const current = latest.get(requirementId);
    if (!current || revision > current.revision) {
      latest.set(requirementId, { revision, createdAt: numberValue(row.created_at) });
    }
  }
  return [...latest.entries()].map(([requirementId, draft]) => {
    const title = requirementTitle.get(requirementId) ?? requirementId;
    return {
      id: `${source}:${requirementId}:${draft.revision}`,
      kind: "approval" as const,
      title,
      requirement: { id: requirementId, title },
      waitingSinceMs: draft.createdAt,
      question: "",
      options: [],
      action: { label: text.todoActionLabel, href: todoHref(requirementId) },
    };
  });
}

function assemble(rows: OverviewRows, query: OverviewReadQuery): Omit<OverviewSnapshot, "revision"> {
  const rangeStart = query.nowMs - SEVEN_DAYS_MS;

  const todos = [...rows.clarifyTodos, ...rows.prdTodos, ...rows.solutionTodos]
    .toSorted((a, b) => a.waitingSinceMs - b.waitingSinceMs || a.id.localeCompare(b.id, "en"));
  const waitingRequirementIds = new Set(todos.map((item) => item.requirement.id));

  const active: OverviewActiveItem[] = [];
  for (const requirement of rows.requirements) {
    if (!RUNNING_REQUIREMENT_STATES.has(requirement.state)) continue;
    if (waitingRequirementIds.has(requirement.id)) continue;
    active.push({
      id: requirement.id,
      type: "requirement",
      name: requirement.title,
      stage: asStage(requirement.state),
      status: "running",
      changedAtMs: requirement.updatedAt,
      detailHref: detailHref(requirement.id),
    });
  }
  for (const story of rows.stories) {
    if (!RUNNING_STORY_STATES.has(story.state)) continue;
    active.push({
      id: story.id,
      type: "task",
      name: story.title,
      stage: asStage(story.phase ?? story.state),
      status: "running",
      changedAtMs: story.updatedAt,
      detailHref: detailHref(story.id),
    });
  }
  active.sort((a, b) => b.changedAtMs - a.changedAtMs || a.id.localeCompare(b.id, "en"));

  const latestFailureEvent = new Map<string, { ts: number; data: unknown }>();
  for (const event of rows.failureEvents) latestFailureEvent.set(event.cardId, { ts: event.ts, data: event.data });
  const latestFailedRun = new Map<string, { phase: string; failure: string | null; endedAt: number | null }>();
  for (const run of rows.failedRuns) latestFailedRun.set(run.cardId, run);

  const failures: OverviewFailureItem[] = [];
  for (const requirement of rows.requirements) {
    if (requirement.state !== "FAILED") continue;
    const event = latestFailureEvent.get(requirement.id);
    const data = (event?.data ?? {}) as { from?: unknown; reason?: unknown };
    failures.push({
      id: requirement.id,
      type: "requirement",
      name: requirement.title,
      stage: asStage(typeof data.from === "string" ? data.from : "CLARIFY"),
      status: "failed",
      reason: typeof data.reason === "string" ? data.reason : text.requirementFailureReason,
      failedAtMs: event?.ts ?? requirement.updatedAt,
      detailHref: detailHref(requirement.id),
    });
  }
  for (const story of rows.stories) {
    if (story.state !== "FAILED") continue;
    const run = latestFailedRun.get(story.id);
    failures.push({
      id: story.id,
      type: "task",
      name: story.title,
      stage: asStage(run?.phase ?? story.phase ?? story.state),
      status: "failed",
      reason: run?.failure ?? text.storyFailureReason,
      failedAtMs: run?.endedAt ?? story.updatedAt,
      detailHref: detailHref(story.id),
    });
  }
  failures.sort((a, b) => b.failedAtMs - a.failedAtMs || a.id.localeCompare(b.id, "en"));

  const completed: OverviewCompletedItem[] = [];
  const inRange = (at: number) => at >= rangeStart && at <= query.nowMs;
  for (const requirement of rows.requirements) {
    if (requirement.state !== "DONE" || !inRange(requirement.updatedAt)) continue;
    completed.push({
      id: requirement.id,
      type: "requirement",
      name: requirement.title,
      status: "completed",
      completedAtMs: requirement.updatedAt,
      detailHref: detailHref(requirement.id),
    });
  }
  for (const story of rows.stories) {
    if (story.state !== "DELIVERED" || !inRange(story.updatedAt)) continue;
    completed.push({
      id: story.id,
      type: "task",
      name: story.title,
      status: "completed",
      completedAtMs: story.updatedAt,
      detailHref: detailHref(story.id),
    });
  }
  completed.sort((a, b) => b.completedAtMs - a.completedAtMs || a.id.localeCompare(b.id, "en"));

  const requirementIds = new Set(rows.requirements.map((row) => row.id));
  let costUsd = 0;
  for (const entry of rows.costs) costUsd += entry.usd;

  const overrunsFrom = (entries: OverviewRows["costs"]): OverviewCostOverrun[] => {
    const spendByRequirement = new Map<string, number>();
    for (const entry of entries) {
      if (entry.cardId === null) continue;
      const requirementId = requirementIds.has(entry.cardId)
        ? entry.cardId
        : rows.storyRequirement.get(entry.cardId) ?? rows.epicRequirement.get(entry.cardId);
      if (requirementId === undefined) continue;
      spendByRequirement.set(requirementId, (spendByRequirement.get(requirementId) ?? 0) + entry.usd);
    }
    const list: OverviewCostOverrun[] = [];
    for (const [requirementId, spent] of spendByRequirement) {
      const rounded = Math.round(spent * 100) / 100;
      if (rounded <= rows.ceilingUsd) continue;
      list.push({
        requirementId,
        requirementName: rows.requirements.find((row) => row.id === requirementId)?.title ?? requirementId,
        spentUsd: rounded,
        limitUsd: rows.ceilingUsd,
        status: "over_limit",
        workContinues: true,
        costsHref: costsHref(requirementId),
      });
    }
    list.sort((a, b) => b.spentUsd - a.spentUsd || a.requirementId.localeCompare(b.requirementId, "en"));
    return list;
  };

  const overruns = overrunsFrom(rows.costs);
  // The ceiling bounds the requirement, not the summary window, so the list a
  // person acts on is the whole spend; `overruns` above stays the part of it
  // that falls inside the seven days the rest of the summary describes.
  const lifetimeOverruns = overrunsFrom(rows.lifetimeCosts);

  const empty = todos.length === 0 && active.length === 0 && failures.length === 0 && completed.length === 0;

  return {
    generatedAtMs: query.nowMs,
    contentState: empty ? { kind: "empty" } : { kind: "ready" },
    sections: { todos, active, failures, completed },
    summary: {
      range: { startInclusiveMs: rangeStart, endInclusiveMs: query.nowMs, timeZone: query.timeZone },
      completedCount: completed.length,
      runningCount: active.length,
      failureCount: failures.length,
      costUsd: Math.round(costUsd * 100) / 100,
      overruns,
      lifetimeOverruns,
    },
  };
}

export function createLibsqlOverviewReader(client: Client): OverviewReadPort {
  let sequence = 0;
  return {
    async readOverview(query): Promise<OverviewSnapshot> {
      const rangeStart = query.nowMs - SEVEN_DAYS_MS;
      const tx = await client.transaction("read");
      try {
        const rows = await readRows(tx, rangeStart, query.nowMs);
        await tx.commit();
        sequence += 1;
        const revision = `${String(query.nowMs).padStart(16, "0")}-${String(sequence).padStart(6, "0")}`;
        return { revision, ...assemble(rows, query) };
      } catch (cause) {
        await tx.rollback();
        throw cause;
      } finally {
        tx.close();
      }
    },
  };
}

/**
 * The controller owns at most one request at a time. A timer refreshes visible
 * pages no later than the interval, visibility restoration refreshes
 * immediately, and stale responses never replace a newer revision. Existing
 * content remains published with refreshing=true until replacement succeeds.
 */
export function createOverviewRefreshController(input: {
  transport: OverviewSnapshotTransport;
  timeZone: string;
  refreshIntervalMs: 30000;
  schedule: (delayMs: number, task: () => void) => unknown;
  cancel: (handle: unknown) => void;
}): OverviewRefreshController {
  const listeners = new Set<(state: OverviewViewState) => void>();
  let state: OverviewViewState = { kind: "loading", scope: TODOS_SCOPE };
  let latest: OverviewSnapshot | null = null;
  let timer: unknown = null;
  let inFlight: AbortController | null = null;
  let started = false;

  const publish = (next: OverviewViewState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const cancelTimer = (): void => {
    if (timer === null) return;
    input.cancel(timer);
    timer = null;
  };

  const scheduleNext = (): void => {
    cancelTimer();
    if (!started) return;
    timer = input.schedule(input.refreshIntervalMs, () => {
      timer = null;
      void refresh();
    });
  };

  async function refresh(): Promise<void> {
    if (inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    const previous = latest;
    if (previous) publish({ kind: "content", snapshot: previous, refreshing: true });
    try {
      const snapshot = await input.transport.fetchOverview({ timeZone: input.timeZone, signal: controller.signal });
      if (inFlight !== controller) return;
      inFlight = null;
      if (previous && snapshot.revision <= previous.revision) {
        publish({ kind: "content", snapshot: previous, refreshing: false });
      } else {
        latest = snapshot;
        publish({ kind: "content", snapshot, refreshing: false });
      }
      scheduleNext();
    } catch {
      if (inFlight !== controller) return;
      inFlight = null;
      cancelTimer();
      publish(previous
        ? { kind: "error", previous, retryable: true }
        : { kind: "error", retryable: true });
    }
  }

  return {
    current: () => state,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(): void {
      if (started) return;
      started = true;
      void refresh();
    },
    stop(): void {
      started = false;
      cancelTimer();
      const controller = inFlight;
      inFlight = null;
      controller?.abort();
    },
    retry(): void {
      void refresh();
    },
    visibilityChanged(visible: boolean): void {
      if (visible && started) void refresh();
    },
  };
}
