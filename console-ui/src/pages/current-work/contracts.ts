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

/** The default view: nothing read yet, the current round selected and the
 * history closed. A person arrives on the current round and opens history only
 * when they ask for it. */
export function initialCurrentWorkDetailView(): CurrentWorkDetailViewState {
  return {
    status: "idle",
    requestId: 0,
    detail: null,
    selectedRound: null,
    historyExpanded: false,
  };
}

/**
 * Moves the detail screen between its states.
 *
 * A load starts a new request and changes nothing else, so a refresh never
 * blanks the content a person is reading. A response is applied only when it
 * answers the newest request; a superseded one is dropped whole. Selecting a
 * round and opening the history are a person's own moves and no read
 * overwrites them.
 */
export function reduceCurrentWorkDetailView(
  state: CurrentWorkDetailViewState,
  action: CurrentWorkDetailViewAction,
): CurrentWorkDetailViewState {
  switch (action.type) {
    case "load":
      return { ...state, status: "loading", requestId: state.requestId + 1 };
    case "loaded":
      if (action.requestId !== state.requestId) return state;
      if (action.result.kind === "failed") return { ...state, status: "error" };
      return { ...state, status: "ready", detail: action.result.detail };
    case "select_round":
      return { ...state, selectedRound: action.round };
    case "set_history_expanded":
      return { ...state, historyExpanded: action.expanded };
  }
}

/** The detail route for one running entry. Identity decides the route, so a
 * task is never sent to a requirement's screen. */
export function detailPath(entry: RunningEntryDto): string {
  return entry.kind === "requirement"
    ? `/requirements/${encodeURIComponent(entry.requirementId)}/detail`
    : `/stories/${encodeURIComponent(entry.cardId)}/detail`;
}
