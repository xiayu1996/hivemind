export interface WorkRecordSearchQuery {
  /** A trimmed, case-sensitive substring matched only against display-safe event text. */
  keyword: string;
  /** Omitted means every agent role. */
  role?: string;
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

export interface WorkRecordMatch {
  runId: string;
  role: string;
  name: string;
  occurredAt: number;
  requirement: WorkRecordRequirementRef;
  /** Ordered parts preserve the source sentence while making every literal hit explicit. */
  hit: readonly HighlightedTextPart[];
}

export interface WorkRecordSearchResult {
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

export type WorkRecordReadFailureCode = "unavailable" | "invalid_query" | "not_found";

export declare class WorkRecordReadError extends Error {
  readonly code: WorkRecordReadFailureCode;
  readonly retryable: boolean;
  constructor(code: WorkRecordReadFailureCode, retryable: boolean, message: string);
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

export function createWorkRecordReader(
  _source: WorkRecordSource,
  _options: WorkRecordReaderOptions = {},
): WorkRecordReader {
  throw new Error("Not implemented: createWorkRecordReader");
}
