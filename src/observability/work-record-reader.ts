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
export declare function mergeWorkRecordContinuation(
  current: WorkRecordDetail,
  requestedAfterSequence: number,
  continuation: WorkRecordDetailResult,
): WorkRecordContinuationResult;

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
 * literal matching and ordering all happen here. Search is a trimmed,
 * case-sensitive literal substring over redacted text, keeps at most one match
 * per run (the latest matching step, which is the current diagnostic context)
 * and orders matches newest first.
 */
export function createWorkRecordReader(
  source: WorkRecordSource,
  options: WorkRecordReaderOptions = {},
): WorkRecordReader {
  const now = options.now ?? Date.now;

  return {
    async search(query: WorkRecordSearchQuery): Promise<WorkRecordSearchResult> {
      const keyword = query.keyword.trim();
      if (keyword === "") throw new WorkRecordReadError("invalid_query", false, "a search keyword is required");
      if (!(query.fromInclusive < query.toExclusive)) {
        throw new WorkRecordReadError("invalid_query", false, "the time range must be a non-empty half-open interval");
      }
      const runs = await guardUnavailable(() => source.loadRuns());
      const matches: WorkRecordMatch[] = [];
      for (const run of runs) {
        if (query.role !== undefined && run.role !== query.role) continue;
        const steps = displaySteps(await guardUnavailable(() => source.loadSteps(run.runId)), run.runId);
        for (const step of steps.toReversed()) {
          const text = redactForExport(step.text);
          if (!text.includes(keyword)) continue;
          if (step.occurredAt < query.fromInclusive || step.occurredAt >= query.toExclusive) continue;
          matches.push({
            runId: run.runId,
            role: run.role,
            name: run.name,
            occurredAt: step.occurredAt,
            requirement: run.requirement,
            hit: literalParts(text, keyword),
          });
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
