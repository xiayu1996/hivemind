import type { Client } from "@libsql/client";
import type { FastifyInstance } from "fastify";

/**
 * One requirement card's progress, as the console's detail screen reads it: the
 * round a person is looking at, plus the rounds before it.
 *
 * A round is not a new object this file invents. It is the serial number the
 * executor already writes on every phase run and every verification
 * (`phase_runs.round`, `verify_records.round`), it is never reset across a
 * resume, and it is never reused -- which is what lets a person come back to
 * "round 2" and find the same work they left. The screen reads one snapshot of
 * the existing ledger; nothing new is persisted, and nothing here writes.
 */

/** The console serves one requirement's progress payload here; `:storyId` is
 * the Story id. Read-only, like every other GET on this console. */
export const STORY_PROGRESS_API_PATH = "/api/stories/:storyId/progress";

/**
 * Why a round exists, in the three causes a person can act on: the card's own
 * first stretch of work, a stretch bought because the previous result was
 * refused, and a stretch bought because a person moved the card on after it
 * stopped. Nothing else starts a round, so the screen never says "unknown".
 */
export type StoryRoundTrigger = "first_run" | "rework" | "restart";

/** What the ledger says about how one round began. */
export interface StoryRoundStartEvidence {
  round: number;
  /** The person's comment the executor applied to this round, if a comment did. */
  feedbackChannel: "answer" | "rework" | "defect" | null;
  feedbackBody: string | null;
  /** A result was refused before this round began: a rejected verification, an
   * invalidated phase, or a merge the card's own work broke. */
  refusedPreviousResult: boolean;
  /** A person moved the card back into work themselves: answered a blocker,
   * unparked it, or dragged it back to the running column. */
  humanRestart: boolean;
}

/** One acceptance item of the frozen contract, and how one round left it. */
export interface StoryRoundAcceptance {
  scenarioId: string;
  text: string;
  outcome: "passed" | "failed";
}

/**
 * What one round's own verification concluded. `pending` is the round still
 * running with no conclusion a person can read yet; it is deliberately not the
 * same value as `available` with no items, which is a round that concluded and
 * reached nothing. The screen says different things about the two.
 */
export type StoryRoundResult =
  | { state: "pending" }
  | { state: "available"; items: readonly StoryRoundAcceptance[] };

/**
 * A failed acceptance item of this round. Blockers are kept apart from the
 * round's results because a read that failed is not a blocker -- a screen that
 * cannot read the card says so about the read, never about the work.
 */
export interface StoryRoundBlocker {
  scenarioId: string;
  text: string;
}

export interface StoryProgressRound {
  /** The executor's serial number. Never reset, never renumbered. */
  round: number;
  trigger: StoryRoundTrigger;
  /** The words of the person who started this round, when a comment did. */
  triggerNote: string | null;
  /** The phase this round reached. */
  phase: string;
  /** When this round's first phase run started. */
  startedAt: number;
  /** When its last phase run ended; null while the round is still open. */
  endedAt: number | null;
  /** This round's own results, never the carry-forwards of another round's. */
  result: StoryRoundResult;
  /** This round's own failed acceptance items. Empty is a real answer. */
  blockers: readonly StoryRoundBlocker[];
  /** What the ledger recorded against this round's own phase runs, in USD. */
  costUsd: number;
}

export interface StoryProgressSnapshot {
  storyId: string;
  title: string;
  state: string;
  /** Names the round the card is in. Must be one of `rounds`. */
  currentRoundId: number;
  /** Oldest first, one entry per round the card actually ran. Never a
   * placeholder: the "no work round yet" screen depends on this being empty. */
  rounds: readonly StoryProgressRound[];
  /** Every cost recorded against this card, not only the rounds' own. */
  totalCostUsd: number;
  /** The requirement's spend ceiling in USD, or null when none is in force. */
  costCeilingUsd: number | null;
  /** Whether work is still moving. Independent of the cost ceiling: reaching
   * the ceiling is a fact about money, never a claim that the work stopped. */
  workState: "running" | "stopped";
  generatedAt: number;
}

/**
 * The answers a read can give. `empty` is a successful read that found no
 * round, and carries no phase or cost field: a screen must not invent a phase
 * or a zero-dollar spend for a card that has not run. `not_found` is separate
 * from `failed` so the route can answer 404 for a card that is not there and a
 * server error for a store that did not answer. `invalid_projection` is the
 * snapshot that could not be true -- the screen refuses it rather than guessing.
 */
export type StoryProgressReadResult =
  | { kind: "progress"; snapshot: StoryProgressSnapshot }
  | { kind: "empty"; storyId: string }
  | { kind: "not_found" }
  | { kind: "invalid_projection"; reason: string }
  | { kind: "failed" };

export interface StoryProgressReadPort {
  readStoryProgress(storyId: string): Promise<StoryProgressReadResult>;
}

/**
 * Why the round began, and the person's own words when they started it.
 *
 * The first round is always the card's own first stretch of work. A rework or
 * defect comment, or a refused result with no comment, means the previous
 * result did not stand (`rework`). Anything else that moved the card on after
 * the first round can only have been a person (`restart`).
 */
export function classifyRoundStart(
  _evidence: StoryRoundStartEvidence,
): { trigger: StoryRoundTrigger; note: string | null } {
  return { trigger: "first_run", note: null };
}

/** The round a person is looking at when they open the card: the last one, or
 * null when the card has not run any. */
export function currentRound(_snapshot: StoryProgressSnapshot): StoryProgressRound | null {
  return null;
}

/** One round by its serial number, or null when this story has no such round. */
export function roundByNumber(_snapshot: StoryProgressSnapshot, _round: number): StoryProgressRound | null {
  return null;
}

/**
 * The invariants a snapshot must satisfy to be shown, or null when it does.
 * A projection that breaks one of these is a read the screen refuses: guessing
 * which round is current, or letting a cumulative total understate its rounds,
 * is how a person ends up reading a true-looking number that is not true.
 */
export function validateSnapshot(_snapshot: StoryProgressSnapshot): string | null {
  return null;
}

/**
 * Reads one snapshot of the ledger for one requirement. Read-only: it takes no
 * lock, writes no row, and cannot move a card.
 */
export class LibsqlStoryProgressReadPort implements StoryProgressReadPort {
  private readonly client: Client;
  private readonly now: () => number;

  constructor(client: Client, now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  async readStoryProgress(_storyId: string): Promise<StoryProgressReadResult> {
    void this.client;
    void this.now;
    return { kind: "failed" };
  }
}

/**
 * The one read route. It maps each read answer to a status a client can act on
 * and never returns another card's data in place of the one asked for.
 */
export function registerStoryProgressRoute(_app: FastifyInstance, _port: StoryProgressReadPort): void {
  // Registered by CODE.
}

/** Exactly one of these is current. `empty` is a read that worked and found no
 * round; `error` is a read that did not work. */
export type StoryProgressViewStatus = "idle" | "loading" | "ready" | "empty" | "error";

export interface StoryProgressViewState {
  readonly storyId: string;
  readonly status: StoryProgressViewStatus;
  /** Increments per read; a response is applied only when it answers the newest. */
  readonly requestId: number;
  /** The last snapshot a read returned, kept across a loading or failed read so
   * the screen does not blank out under a person. */
  readonly snapshot: StoryProgressSnapshot | null;
  /** The round a person picked. Null means the current round, and follows the
   * card as it moves on. Never set by a read. */
  readonly selectedRoundId: number | null;
}

export type StoryProgressViewAction =
  | { readonly type: "load" }
  | { readonly type: "loaded"; readonly requestId: number; readonly result: StoryProgressReadResult }
  | { readonly type: "select"; readonly round: number };

export function initialStoryProgressView(storyId: string): StoryProgressViewState {
  return { storyId, status: "idle", requestId: 0, snapshot: null, selectedRoundId: null };
}

/**
 * Moves the screen between its states. A load starts a new request and changes
 * nothing else, so a refresh never blanks the screen and never moves a person
 * off the round they are reading. A response is applied only when it belongs to
 * the newest request; a superseded one is dropped whole. Selection is a
 * person's, and no read overwrites it.
 */
export function reduceStoryProgressView(
  state: StoryProgressViewState,
  _action: StoryProgressViewAction,
): StoryProgressViewState {
  return state;
}

/** The round the screen is showing: the picked one, or the current one. Null
 * while nothing has been read, or in the empty state. */
export function selectedRoundOf(_state: StoryProgressViewState): StoryProgressRound | null {
  return null;
}

/**
 * The screen's own words. Every label a person reads is here once, so two
 * places cannot drift into naming the same thing differently. The values are
 * frozen by the card's definition of done, not chosen here.
 */
export const STORY_PROGRESS_COPY = {
  currentRoundTab: "当前轮",
  roundSwitcherHeading: "轮次切换与历史",
  historyHeading: "历史轮次",
  currentRoundPanelHeading: "当前轮阶段与结果",
  roundCostHeading: "本轮费用",
  totalCostHeading: "累计费用",
  loading: "正在读取当前轮与历史轮次",
  failed: "无法读取需求进展",
  retry: "重新读取",
  resultsPending: "本轮结果尚未产生，将自动刷新",
  noRounds: "当前还没有工作轮次",
  backToOverview: "返回运行总览",
  overLimitStatus: "已超限",
  workContinues: "工作仍继续",
  noBlocker: "卡点：无",
} as const;

/** `第 2 轮`, and `当前轮` for the round the card is in. */
export function formatRoundLabel(_round: number, _currentRoundId: number): string {
  return "";
}

/** The heading of a round's own panel: `当前轮阶段与结果` for the current
 * round, `第 2 轮` for an older one. */
export function formatRoundPanelHeading(_round: number, _currentRoundId: number): string {
  return "";
}

/** `触发原因：重新开始`, from the round's own recorded cause, never a guess. */
export function formatRoundTriggerLine(_round: StoryProgressRound): string {
  return "";
}

/** `阶段：VERIFY`: the phase this round reached. */
export function formatRoundPhaseLine(_round: StoryProgressRound): string {
  return "";
}

/** `已取得的结果：3 项验收已通过`, counted from the round's own results. A round
 * that has not concluded anything yet says so instead, never `0 项`. */
export function formatRoundResultLine(_round: StoryProgressRound): string {
  return "";
}

/** `卡点：1 项验收未通过`, counted from the round's own blockers, or `卡点：无`.
 * A read that failed is never one of these. */
export function formatRoundBlockerLine(_round: StoryProgressRound): string {
  return "";
}

/** `$1.24（本需求当前轮）`: the amount and the scope it covers, never one
 * without the other. */
export function formatRoundCostValue(_round: StoryProgressRound, _currentRoundId: number): string {
  return "";
}

/** `$3.80（本需求全部轮次）`: every recorded cost of this story, marked as a
 * different statistic from one round's. */
export function formatTotalCostValue(_totalUsd: number): string {
  return "";
}

/** Whether the spend ceiling is reached. `over` is a fact about money only. */
export function limitStateOf(_snapshot: StoryProgressSnapshot): "normal" | "over" {
  return "normal";
}

/** `上限 $10.00`, or null when no ceiling is in force. */
export function formatLimitLine(_snapshot: StoryProgressSnapshot): string | null {
  return null;
}

/** `已超限`, or null while the card is under its ceiling. */
export function formatLimitStateLine(_snapshot: StoryProgressSnapshot): string | null {
  return null;
}

/** `工作仍继续` while work is moving; never the word `已暂停`, which states the
 * card stopped when the only fact is that it spent. */
export function formatWorkStateLine(_snapshot: StoryProgressSnapshot): string {
  return "";
}
