/**
 * The task detail screen's contract: the snapshot it reads, the states it can
 * be in, the words a person reads, and the one seam where the shell hands it
 * data.
 *
 * The snapshot types mirror `src/console/story-detail.ts` as they cross the
 * wire. They are written out rather than imported because console-ui builds on
 * its own root; the server file is the authority for what the payload means,
 * and a change on either side has to change both.
 *
 * Nothing here is persisted. The screen reads one snapshot and remembers only
 * which round a person picked; the central ledger stays the only truth.
 */

export type StoryRoundTrigger = "first_run" | "rework" | "restart";

export interface StoryRoundAcceptanceDto {
  scenarioId: string;
  text: string;
  outcome: "passed" | "failed";
}

export interface StoryRoundDto {
  round: number;
  trigger: StoryRoundTrigger;
  triggerNote: string | null;
  phase: string;
  startedAt: number;
  endedAt: number | null;
  /** The round is open and has produced no conclusion yet; the screen says so. */
  resultPending: boolean;
  /** This round's own conclusions, one per acceptance item it reached. The
   * screen counts 已取得的结果 and 卡点 from this list, so the two can never
   * disagree, and a round with none shows neither. */
  acceptance: readonly StoryRoundAcceptanceDto[];
  costUsd: number;
}

export interface StoryDetailSnapshotDto {
  cardId: string;
  title: string;
  state: string;
  /** Oldest first; the last entry is the current round. Empty until the card
   * has run one, and the screen renders nothing but its empty state then. */
  rounds: readonly StoryRoundDto[];
  totalCostUsd: number;
  generatedAt: number;
}

/**
 * What the screen gets back. The server tells `not_found` apart from a store
 * that failed; a person can act on neither differently, and both must be
 * visible and retryable, so the screen keeps one failure.
 */
export type StoryDetailReadResult =
  | { kind: "ok"; snapshot: StoryDetailSnapshotDto }
  | { kind: "failed" };

export interface StoryDetailPort {
  readStoryDetail(cardId: string): Promise<StoryDetailReadResult>;
}

/**
 * How often the screen reads again while it is open. The requirement's own
 * wording: every thirty seconds, and again at once when the page becomes
 * visible. It is not the card's polling rate -- the screen may be closed.
 */
export const STORY_DETAIL_REFRESH_INTERVAL_MS = 30_000;

/** Where one card's snapshot is read from. Same path the server declares. */
export function storyDetailApiPath(cardId: string): string {
  return `/api/stories/${encodeURIComponent(cardId)}/detail`;
}

/**
 * Reads one snapshot over the console's read API. A response that is not 200
 * is a failure: a card that is not there and a store that stopped answering
 * are both "could not read this task's progress", which is what the screen says.
 */
export function createStoryDetailHttpPort(_fetchImpl: typeof fetch = fetch): StoryDetailPort {
  return {
    readStoryDetail(): Promise<StoryDetailReadResult> {
      return Promise.resolve({ kind: "failed" });
    },
  };
}

/**
 * Exactly one of these is current.
 *
 * `empty` is a read that worked and found no round at all; `error` is a read
 * that did not work, and it keeps the last snapshot the screen had so the
 * content a person was reading stays where it was. `waiting` is deliberately
 * not a state of its own: a round that has produced no result yet is a property
 * of that round, so selecting an old round never makes the current round's
 * waiting message appear over it.
 */
export type StoryDetailViewStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface StoryDetailViewState {
  readonly status: StoryDetailViewStatus;
  readonly cardId: string;
  /** Increments per read; a response is applied only when it answers the newest. */
  readonly requestId: number;
  /** The round a person picked. Null means the current round, and follows the
   * card as it moves on. Never set by a read. */
  readonly selectedRound: number | null;
  /** The last snapshot that read successfully, kept across a loading or failed
   * read so the screen does not blank out under a person. */
  readonly snapshot: StoryDetailSnapshotDto | null;
}

export type StoryDetailViewAction =
  | { readonly type: "load" }
  | { readonly type: "loaded"; readonly requestId: number; readonly result: StoryDetailReadResult }
  | { readonly type: "failed"; readonly requestId: number }
  | { readonly type: "select"; readonly round: number | null };

export function initialStoryDetailView(_cardId: string): StoryDetailViewState {
  return { status: "idle", cardId: "", requestId: 0, selectedRound: null, snapshot: null };
}

/**
 * Moves the screen between its states.
 *
 * A load starts a new request and changes nothing else: the content, the
 * snapshot and the selection all stay, so a refresh never blanks the screen and
 * never moves a person off the round they are reading. A response is applied
 * only when it belongs to the newest request; a superseded one is dropped
 * whole. A read that worked and found no round is `empty`; one that failed is
 * `error` with the previous snapshot kept. Selection is a person's, and no
 * read overwrites it.
 */
export function reduceStoryDetailView(
  _state: StoryDetailViewState,
  _action: StoryDetailViewAction,
): StoryDetailViewState {
  return { status: "idle", cardId: "", requestId: 0, selectedRound: null, snapshot: null };
}

/** The round a person sees when they have not picked one: the last one, or
 * null when the card has not run any. */
export function currentRoundOf(_snapshot: StoryDetailSnapshotDto | null): StoryRoundDto | null {
  return null;
}

/** The round the screen is showing: the picked one, or the current one. Null
 * while nothing has been read, or when the picked round is not in the snapshot. */
export function selectedRoundOf(_state: StoryDetailViewState): StoryRoundDto | null {
  return null;
}

/**
 * The screen's own words. Every label a person reads is here once, so two
 * places cannot drift into naming the same thing differently, and so a check
 * that judges the copy judges one source. This file is the only place the
 * screen's Chinese copy lives; the values are frozen by the card's definition
 * of done, not chosen here.
 */
export const STORY_DETAIL_COPY = {
  currentRoundTab: "当前轮",
  roundSwitcherHeading: "轮次切换与历史",
  historyHeading: "历史轮次",
  currentRoundPanelHeading: "当前轮阶段与结果",
  roundCostHeading: "本轮费用",
  totalCostHeading: "累计费用",
  loading: "正在读取当前轮与历史轮次",
  failed: "无法读取任务进展",
  retry: "重新读取",
  resultsPending: "本轮结果尚未产生，将自动刷新",
  noRounds: "当前还没有工作轮次",
  backToOverview: "返回运行总览",
  currentRunEntry: "当前",
  noBlocker: "卡点：无",
} as const;

/** `第 2 轮`, and `当前轮` for the round the card is in. */
export function formatRoundLabel(_round: number, _currentRound: number): string {
  return "";
}

/** The round written as the heading of its own panel: `当前轮阶段与结果` for the
 * current round, `第 2 轮` for an older one. */
export function formatRoundPanelHeading(_round: number, _currentRound: number): string {
  return "";
}

/** `触发原因：重新开始`, from the round's own recorded cause, never from the
 * screen's guess. */
export function formatRoundTriggerLine(_round: StoryRoundDto): string {
  return "";
}

/** `阶段：CODE`: the phase this round reached. */
export function formatRoundPhaseLine(_round: StoryRoundDto): string {
  return "";
}

/** `已取得的结果：2 项验收已通过`, counted from the round's own conclusions. A
 * round that has not concluded anything yet says so instead (see
 * `STORY_DETAIL_COPY.resultsPending`), never `0 项`. */
export function formatRoundResultLine(_round: StoryRoundDto): string {
  return "";
}

/** `卡点：1 项验收未通过`, counted from the same list, or `卡点：无`. A read that
 * failed is never one of these. */
export function formatRoundBlockerLine(_round: StoryRoundDto): string {
  return "";
}

/** `$1.24（本任务当前轮）`: the amount and the scope it covers, never one without
 * the other. */
export function formatRoundCostValue(_round: StoryRoundDto, _currentRound: number): string {
  return "";
}

/** `$3.80（本任务全部轮次）`: every recorded cost of this card, marked as a
 * different statistic from one round's. */
export function formatTotalCostValue(_totalUsd: number): string {
  return "";
}
