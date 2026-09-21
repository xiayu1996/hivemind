/**
 * Read contracts for the running overview and the two person-visible detail
 * screens. These projections never own execution state; they take one
 * consistent snapshot of the central ledger and never write to it.
 */

export type CurrentWorkKind = "requirement" | "task";
export type CurrentWorkState = "running";

export interface RequirementWorkRef {
  kind: "requirement";
  requirementId: string;
}

export interface TaskWorkRef {
  kind: "task";
  cardId: string;
  requirementId: string;
}

export type CurrentWorkRef = RequirementWorkRef | TaskWorkRef;

interface RunningOverviewEntryBase {
  /** The person-visible title. An internal id must never be used as fallback copy. */
  title: string;
  state: CurrentWorkState;
  phase: string;
}

export interface RunningRequirementOverviewEntry extends RunningOverviewEntryBase {
  kind: "requirement";
  requirementId: string;
}

export interface RunningTaskOverviewEntry extends RunningOverviewEntryBase {
  kind: "task";
  cardId: string;
  requirementId: string;
}

export type RunningOverviewEntry =
  | RunningRequirementOverviewEntry
  | RunningTaskOverviewEntry;

export interface RunningOverviewSnapshot {
  /** Requirements and tasks are separate rows, ordered by title and stable id. */
  entries: readonly RunningOverviewEntry[];
  generatedAt: number;
}

export type RunningOverviewReadResult =
  | { kind: "ok"; snapshot: RunningOverviewSnapshot }
  | { kind: "failed"; message: string };

export interface CurrentRoundResultItem {
  resultId: string;
  text: string;
}

export interface CurrentRoundBlocker {
  blockerId: string;
  text: string;
}

export interface CurrentRoundSummary {
  /** The ledger ordinal; it is never reset or reused. */
  round: number;
  phase: string;
  results: readonly CurrentRoundResultItem[];
  blockers: readonly CurrentRoundBlocker[];
  costUsd: number;
  startedAt: number;
}

export interface HistoricalRoundReference {
  round: number;
  phase: string;
  trigger: "first_run" | "rework" | "restart";
}

export interface RequirementTaskEntry {
  kind: "task";
  cardId: string;
  requirementId: string;
  title: string;
  state: CurrentWorkState;
}

interface CurrentWorkDetailBase {
  /** The person-visible title. Internal ids remain route handles only. */
  title: string;
  state: CurrentWorkState;
  currentRound: CurrentRoundSummary;
  /** References only. Their content is read after an explicit selection. */
  historicalRounds: readonly HistoricalRoundReference[];
  generatedAt: number;
}

export interface RequirementCurrentWorkDetail extends CurrentWorkDetailBase {
  kind: "requirement";
  requirementId: string;
  tasks: readonly RequirementTaskEntry[];
}

export interface TaskCurrentWorkDetail extends CurrentWorkDetailBase {
  kind: "task";
  cardId: string;
  parentRequirement: {
    requirementId: string;
    title: string;
  };
}

export type CurrentWorkDetail =
  | RequirementCurrentWorkDetail
  | TaskCurrentWorkDetail;

export type CurrentWorkDetailReadResult =
  | { kind: "ok"; detail: CurrentWorkDetail }
  | { kind: "not_found" }
  | { kind: "failed"; message: string };

/**
 * A read is internally snapshot-consistent. Reads do not lock writers, so a
 * later overview or detail read may legitimately observe newer execution data.
 */
export interface CurrentWorkReadPort {
  readRunningOverview(): Promise<RunningOverviewReadResult>;
  readRequirementDetail(requirementId: string): Promise<CurrentWorkDetailReadResult>;
  readTaskDetail(cardId: string): Promise<CurrentWorkDetailReadResult>;
}

export const RUNNING_OVERVIEW_API_PATH = "/api/current-work";
export const REQUIREMENT_DETAIL_API_PATH = "/api/requirements/:requirementId/detail";
export const TASK_DETAIL_API_PATH = "/api/stories/:cardId/detail";

/** SPECIFY scaffold. CODE replaces this sentinel with the identity-specific route. */
export function currentWorkDetailPath(_ref: CurrentWorkRef): string {
  return "";
}
