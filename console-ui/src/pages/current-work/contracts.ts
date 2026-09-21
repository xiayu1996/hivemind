export type CurrentWorkKind = "requirement" | "task";
export type CurrentWorkState = "running";

export interface RunningRequirementEntryDto {
  kind: "requirement";
  requirementId: string;
  title: string;
  state: CurrentWorkState;
  phase: string;
}

export interface RunningTaskEntryDto {
  kind: "task";
  cardId: string;
  requirementId: string;
  title: string;
  state: CurrentWorkState;
  phase: string;
}

export type RunningEntryDto = RunningRequirementEntryDto | RunningTaskEntryDto;

export interface RunningOverviewDto {
  entries: readonly RunningEntryDto[];
  generatedAt: number;
}

export interface CurrentRoundSummaryDto {
  round: number;
  phase: string;
  results: readonly { resultId: string; text: string }[];
  blockers: readonly { blockerId: string; text: string }[];
  costUsd: number;
  startedAt: number;
}

export interface HistoricalRoundReferenceDto {
  round: number;
  phase: string;
  trigger: "first_run" | "rework" | "restart";
}

interface CurrentWorkDetailDtoBase {
  title: string;
  state: CurrentWorkState;
  currentRound: CurrentRoundSummaryDto;
  historicalRounds: readonly HistoricalRoundReferenceDto[];
  generatedAt: number;
}

export interface RequirementCurrentWorkDetailDto extends CurrentWorkDetailDtoBase {
  kind: "requirement";
  requirementId: string;
  tasks: readonly {
    kind: "task";
    cardId: string;
    requirementId: string;
    title: string;
    state: CurrentWorkState;
  }[];
}

export interface TaskCurrentWorkDetailDto extends CurrentWorkDetailDtoBase {
  kind: "task";
  cardId: string;
  parentRequirement: {
    requirementId: string;
    title: string;
  };
}

export type CurrentWorkDetailDto =
  | RequirementCurrentWorkDetailDto
  | TaskCurrentWorkDetailDto;

export type CurrentWorkDetailReadResult =
  | { kind: "ok"; detail: CurrentWorkDetailDto }
  | { kind: "failed" };

export interface CurrentWorkDetailPort {
  readRequirementDetail(requirementId: string): Promise<CurrentWorkDetailReadResult>;
  readTaskDetail(cardId: string): Promise<CurrentWorkDetailReadResult>;
}

export type CurrentWorkDetailViewStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface CurrentWorkDetailViewState {
  readonly status: CurrentWorkDetailViewStatus;
  /** Only the newest request may replace the visible snapshot. */
  readonly requestId: number;
  readonly detail: CurrentWorkDetailDto | null;
  /** Null means the current round and is the initial selection. */
  readonly selectedRound: number | null;
  /** False initially; history opens only after the person asks for it. */
  readonly historyExpanded: boolean;
}

export type CurrentWorkDetailViewAction =
  | { type: "load" }
  | { type: "loaded"; requestId: number; result: CurrentWorkDetailReadResult }
  | { type: "select_round"; round: number | null }
  | { type: "set_history_expanded"; expanded: boolean };

/** SPECIFY scaffold. CODE replaces this sentinel with the default current-round view. */
export function initialCurrentWorkDetailView(): CurrentWorkDetailViewState {
  return {
    status: "idle",
    requestId: 0,
    detail: null,
    selectedRound: -1,
    historyExpanded: true,
  };
}

/** SPECIFY scaffold. CODE replaces this no-op with latest-request state transitions. */
export function reduceCurrentWorkDetailView(
  state: CurrentWorkDetailViewState,
  _action: CurrentWorkDetailViewAction,
): CurrentWorkDetailViewState {
  return state;
}

/** SPECIFY scaffold. CODE replaces this sentinel with the identity-specific route. */
export function detailPath(_entry: RunningEntryDto): string {
  return "";
}
