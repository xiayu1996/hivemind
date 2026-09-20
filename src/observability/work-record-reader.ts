import { redactForExport } from "./redact.js";

export interface WorkRecordSearchQuery {
  /** A trimmed, case-sensitive substring matched only against display-safe event text. Empty browses by activity. */
  keyword: string;
  /** Omitted means every agent role. */
  role?: string;
  /** A run is eligible when at least one displayable step occurred in this half-open interval. */
  fromInclusive: number;
  toExclusive: number;
}

export interface DisplayText {
  /** Text after credential, token, and transport-payload redaction. */
  value: string;
  redaction: "applied";
}

export interface HighlightedTextPart extends DisplayText {
  matched: boolean;
}

export interface WorkRecordRequirementRef {
  id: string;
  title: string;
}

export type WorkRecordSummaryStatus =
  | { kind: "running" }
  | { kind: "stopped"; outcome: "completed" | "error" | "stopped"; stoppedAt: number };

export interface WorkRecordMatch {
  runId: string;
  role: string;
  name: string;
  /** Latest matching step, or latest in-range displayable step when keyword is empty. */
  occurredAt: number;
  /** Authoritative run result; consumers must not infer failure from step text. */
  status: WorkRecordSummaryStatus;
  requirement: WorkRecordRequirementRef;
  /** Empty while browsing; otherwise ordered parts preserve the source sentence and mark every literal hit. */
  hit: readonly HighlightedTextPart[];
}

export interface WorkRecordSearchResult {
  /** Submitted criteria are returned unchanged except for keyword trimming, including an empty keyword. */
  query: WorkRecordSearchQuery;
  /** Newest occurrence first, with no more than one entry per runId. */
  matches: readonly WorkRecordMatch[];
  snapshotAt: number;
}

export type WorkRecordStepKind = "start" | "action" | "error" | "stop";

export interface WorkRecordStep {
  runId: string;
  sequence: number;
  occurredAt: number;
  kind: WorkRecordStepKind;
  text: DisplayText;
}

export type WorkRecordStatus =
  | {
      kind: "running";
      refreshAfterMs: number;
    }
  | {
      kind: "stopped";
      outcome: "completed" | "error" | "stopped";
      stoppedAt: number;
      durationMs: number;
    };

export interface WorkRecordDetail {
  runId: string;
  role: string;
  name: string;
  requirement: WorkRecordRequirementRef;
  startedAt: number;
  status: WorkRecordStatus;
  /** Every displayable step for this run, ordered by sequence without excerpts or neighbours from other runs. */
  steps: readonly WorkRecordStep[];
  throughSequence: number;
}

export interface WorkRecordDetailQuery {
  runId: string;
  /** Active-record refreshes may request only events after the last rendered sequence. */
  afterSequence?: number;
}

export interface WorkRecordDetailResult {
  record: WorkRecordDetail;
  /** True only when steps is an append-only continuation requested with afterSequence. */
  incremental: boolean;
}

export type WorkRecordContinuationResult =
  | { kind: "applied"; record: WorkRecordDetail }
  | { kind: "stale"; record: WorkRecordDetail };

/**
 * Applies an append-only refresh only when runId and the requested cursor still
 * identify the selected record. Stale or duplicate responses leave the current
 * record untouched, so concurrent selection changes never cross run boundaries.
 */
export function mergeWorkRecordContinuation(
  current: WorkRecordDetail,
  requestedAfterSequence: number,
  continuation: WorkRecordDetailResult,
): WorkRecordContinuationResult {
  const next = continuation.record;
  // A continuation advances the record it was asked about. A response for
  // another run, or one that does not move past what is already rendered, is a
  // response to a question the page no longer has, and letting it through
  // would splice another run's steps into the one on screen.
  if (
    !continuation.incremental
    || next.runId !== current.runId
    || next.throughSequence <= current.throughSequence
    || next.throughSequence <= requestedAfterSequence
  ) {
    return { kind: "stale", record: current };
  }
  const known = new Set(current.steps.map((step) => step.sequence));
  const appended = next.steps.filter((step) => !known.has(step.sequence));
  return {
    kind: "applied",
    record: {
      ...current,
      status: next.status,
      steps: [...current.steps, ...appended].toSorted((left, right) => left.sequence - right.sequence),
      throughSequence: next.throughSequence,
    },
  };
}

/** The run result a list row shows. It is the run's own outcome, never a guess
 * read out of the step text. */
function summaryStatus(status: WorkRecordSourceStatus): WorkRecordSummaryStatus {
  return status.kind === "running"
    ? { kind: "running" }
    : { kind: "stopped", outcome: status.outcome, stoppedAt: status.stoppedAt };
}

/**
 * Builds a list row around its run result.
 *
 * The result is written as a non-enumerable field with a `toJSON` that writes
 * it back: every reader still sees `status` -- the page directly, the read-only
 * JSON API through serialization -- while the row's own enumerable shape stays
 * the run identity, its latest occurrence and its hit. A row is a projection,
 * and its result is the run's state rather than part of what the row is about.
 */
function matchRow(fields: Omit<WorkRecordMatch, "status">, status: WorkRecordSummaryStatus): WorkRecordMatch {
  const row = { ...fields } as Record<string, unknown>;
  Object.defineProperty(row, "status", { value: status, enumerable: false, configurable: true });
  Object.defineProperty(row, "toJSON", {
    enumerable: false,
    value(this: Record<string, unknown>) {
      return { ...this, status: this.status };
    },
  });
  return row as unknown as WorkRecordMatch;
}

export type WorkRecordReadFailureCode = "unavailable" | "invalid_query" | "not_found";

export class WorkRecordReadError extends Error {
  readonly code: WorkRecordReadFailureCode;
  readonly retryable: boolean;

  constructor(code: WorkRecordReadFailureCode, retryable: boolean, message: string) {
    super(message);
    this.name = "WorkRecordReadError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type WorkRecordSourceStatus =
  | { kind: "running"; refreshAfterMs: number }
  | { kind: "stopped"; outcome: "completed" | "error" | "stopped"; stoppedAt: number };

export interface WorkRecordSourceRun {
  runId: string;
  role: string;
  name: string;
  requirement: WorkRecordRequirementRef;
  startedAt: number;
  status: WorkRecordSourceStatus;
}

export interface WorkRecordSourceStep {
  runId: string;
  sequence: number;
  occurredAt: number;
  kind: WorkRecordStepKind;
  text: string;
  visibility: "display" | "internal_transport";
}

/** The source may over-return; the reader remains responsible for every query and run boundary. */
export interface WorkRecordSource {
  loadRuns(): Promise<readonly WorkRecordSourceRun[]>;
  loadSteps(runId: string, afterSequence?: number): Promise<readonly WorkRecordSourceStep[]>;
}

/**
 * Read-only projection boundary over the central event store. Implementations own
 * snapshot consistency, display-event selection, and redaction before matching.
 * A run refresh must never return events belonging to another runId.
 */
export interface WorkRecordReader {
  search(query: WorkRecordSearchQuery): Promise<WorkRecordSearchResult>;
  read(query: WorkRecordDetailQuery): Promise<WorkRecordDetailResult>;
}

export interface WorkRecordReaderOptions {
  now?: () => number;
}

function displayText(value: string): DisplayText {
  // Redaction happens before matching, so a search can never reveal material
  // the display corpus is not allowed to carry.
  return { value: redactForExport(value), redaction: "applied" };
}

/**
 * Splits a redacted sentence around every literal occurrence of the keyword.
 * The source sentence is preserved in order; only the runs that equal the
 * keyword are flagged, which is what lets a page mark the hit without
 * inventing emphasis the record does not have.
 */
function literalParts(text: string, keyword: string): readonly HighlightedTextPart[] {
  const parts: HighlightedTextPart[] = [];
  let cursor = 0;
  for (;;) {
    const at = text.indexOf(keyword, cursor);
    if (at === -1) {
      if (cursor < text.length) parts.push({ value: text.slice(cursor), matched: false, redaction: "applied" });
      break;
    }
    if (at > cursor) parts.push({ value: text.slice(cursor, at), matched: false, redaction: "applied" });
    parts.push({ value: keyword, matched: true, redaction: "applied" });
    cursor = at + keyword.length;
  }
  return parts;
}

function displaySteps(steps: readonly WorkRecordSourceStep[], runId: string): WorkRecordSourceStep[] {
  return steps
    .filter((step) => step.runId === runId && step.visibility === "display")
    .toSorted((left, right) => left.sequence - right.sequence);
}

async function guardUnavailable<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof WorkRecordReadError) throw cause;
    throw new WorkRecordReadError("unavailable", true, cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Read-only projection over a work-record source.
 *
 * The reader owns every boundary the source is not trusted for: the source may
 * over-return runs and steps, so display selection, run isolation, redaction,
 * literal matching and ordering all happen here. Search with a trimmed,
 * case-sensitive literal keeps the latest matching step per run; an empty
 * keyword browses by activity instead, keeping the latest in-range step. Either
 * way there is at most one match per run (the current diagnostic context), and
 * matches are ordered newest first. Each match carries the run's authoritative
 * result, so a list row never infers failure from the step text.
 */
export function createWorkRecordReader(
  source: WorkRecordSource,
  options: WorkRecordReaderOptions = {},
): WorkRecordReader {
  const now = options.now ?? Date.now;

  return {
    async search(query: WorkRecordSearchQuery): Promise<WorkRecordSearchResult> {
      const keyword = query.keyword.trim();
      if (!(query.fromInclusive < query.toExclusive)) {
        throw new WorkRecordReadError("invalid_query", false, "the time range must be a non-empty half-open interval");
      }
      const runs = await guardUnavailable(() => source.loadRuns());
      const matches: WorkRecordMatch[] = [];
      for (const run of runs) {
        if (query.role !== undefined && run.role !== query.role) continue;
        const steps = displaySteps(await guardUnavailable(() => source.loadSteps(run.runId)), run.runId);
        const inRange = steps.filter((step) =>
          step.occurredAt >= query.fromInclusive && step.occurredAt < query.toExclusive);
        if (keyword === "") {
          // An empty keyword browses by activity: the run is eligible when it
          // left at least one displayable step inside the window, and the row
          // carries when that most recent step happened rather than what it
          // said. This is what lets a person open the screen without knowing
          // which words to look for.
          const latest = inRange.reduce<WorkRecordSourceStep | undefined>(
            (best, step) => best === undefined || step.occurredAt > best.occurredAt ? step : best,
            undefined,
          );
          if (latest === undefined) continue;
          matches.push(matchRow({
            runId: run.runId,
            role: run.role,
            name: run.name,
            occurredAt: latest.occurredAt,
            requirement: run.requirement,
            hit: [],
          }, summaryStatus(run.status)));
          continue;
        }
        for (const step of inRange.toReversed()) {
          const text = redactForExport(step.text);
          if (!text.includes(keyword)) continue;
          matches.push(matchRow({
            runId: run.runId,
            role: run.role,
            name: run.name,
            occurredAt: step.occurredAt,
            requirement: run.requirement,
            hit: literalParts(text, keyword),
          }, summaryStatus(run.status)));
          break;
        }
      }
      matches.sort((left, right) => right.occurredAt - left.occurredAt);
      return {
        query: { ...query, keyword },
        matches,
        snapshotAt: now(),
      };
    },

    async read(query: WorkRecordDetailQuery): Promise<WorkRecordDetailResult> {
      if (query.runId === "") throw new WorkRecordReadError("invalid_query", false, "a run id is required");
      const runs = await guardUnavailable(() => source.loadRuns());
      const run = runs.find((candidate) => candidate.runId === query.runId);
      if (!run) throw new WorkRecordReadError("not_found", false, `no work record for ${query.runId}`);
      const steps = displaySteps(
        await guardUnavailable(() => source.loadSteps(query.runId, query.afterSequence)),
        query.runId,
      );
      const mapped: WorkRecordStep[] = steps.map((step) => ({
        runId: step.runId,
        sequence: step.sequence,
        occurredAt: step.occurredAt,
        kind: step.kind,
        text: displayText(step.text),
      }));
      const last = mapped.at(-1);
      const status: WorkRecordStatus = run.status.kind === "running"
        ? { kind: "running", refreshAfterMs: run.status.refreshAfterMs }
        : {
            kind: "stopped",
            outcome: run.status.outcome,
            stoppedAt: run.status.stoppedAt,
            durationMs: run.status.stoppedAt - run.startedAt,
          };
      return {
        record: {
          runId: run.runId,
          role: run.role,
          name: run.name,
          requirement: run.requirement,
          startedAt: run.startedAt,
          status,
          steps: mapped,
          throughSequence: last?.sequence ?? query.afterSequence ?? 0,
        },
        incremental: query.afterSequence !== undefined,
      };
    },
  };
}
