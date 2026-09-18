import type { Client } from "@libsql/client";

/**
 * One task card's progress, as the console's detail screen reads it: the round
 * a person is looking at, plus the rounds before it.
 *
 * A round is not a new object this file invents. It is the serial number the
 * executor already writes on every phase run and every verification
 * (`phase_runs.round`, `verify_records.round`, carried on
 * `stories.inner_loop_rounds`), it is never reset across a resume, and it is
 * never reused -- which is what lets a person come back to "round 2" and find
 * the same work they left. The screen therefore reads one snapshot of the
 * existing ledger; nothing new is persisted, and nothing here writes.
 */

/** The console serves this payload here; `:cardId` is the Story id. */
export const STORY_DETAIL_API_PATH = "/api/stories/:cardId/detail";

/**
 * Why a round exists, in the three causes a person can act on: the card's own
 * first stretch of work, a stretch bought because the previous result was
 * refused, and a stretch bought because a person moved the card on after it
 * stopped. Nothing else starts a round, so the screen never has to say
 * "unknown".
 */
export type StoryRoundTrigger = "first_run" | "rework" | "restart";

/**
 * One acceptance item of the frozen contract, and how one round left it. This
 * round's own conclusions only: an item carried forward from an earlier round
 * is that round's result, and merging them is precisely what makes two rounds
 * read as one. Counting happens from this list, so a count and the reasons a
 * person reads can never disagree. A read that failed produces no item at all:
 * a screen that cannot read the card says so about the read, never about the
 * work.
 */
export interface StoryRoundAcceptance {
  /** The item's id, so the same item can be followed across rounds. */
  scenarioId: string;
  /** The item's own name, as the frozen contract writes it. */
  text: string;
  outcome: "passed" | "failed";
}

export interface StoryRound {
  /** The executor's serial number. Never reset, never renumbered. */
  round: number;
  trigger: StoryRoundTrigger;
  /** The words of the person who started this round, when a comment did. */
  triggerNote: string | null;
  /** The phase this round reached. A round exists because a phase run does, so
   * it always names one. */
  phase: string;
  /** When this round's first phase run started. */
  startedAt: number;
  /** When its last phase run ended; null while the round is still open. */
  endedAt: number | null;
  /**
   * True while the round is open and has produced no conclusion a person can
   * read yet: the phase is running and no verification conclusion exists for
   * it. The screen says so; it must not show zero instead, which reads as
   * "nothing was achieved".
   */
  resultPending: boolean;
  acceptance: readonly StoryRoundAcceptance[];
  /** What the ledger recorded against this round's own phase runs, in USD. */
  costUsd: number;
}

export interface StoryDetailSnapshot {
  cardId: string;
  title: string;
  state: string;
  /**
   * Oldest first, one entry per round the card actually ran; the last entry is
   * the current round. Empty while the card has not run one. Never a
   * placeholder: the "no work round yet" screen depends on this being empty,
   * and on nothing else being filled in for it.
   */
  rounds: readonly StoryRound[];
  /**
   * Every cost recorded against this card, not the sum of `rounds`: money spent
   * on a card without a phase run of its own (a second review lane, a session
   * that resumed) still belongs to the card, and dropping it would make the
   * total understate what the card has cost.
   */
  totalCostUsd: number;
  generatedAt: number;
}

/**
 * The three answers a read can give. `not_found` is separate from `failed` so
 * the route can answer 404 for a card that is not there and 5xx for a store
 * that did not answer; the screen treats both as a read it must show and offer
 * to retry.
 */
export type StoryDetailReadResult =
  | { kind: "ok"; snapshot: StoryDetailSnapshot }
  | { kind: "not_found" }
  | { kind: "failed"; message: string };

/** What the ledger says about how one round began. */
export interface StoryRoundStartEvidence {
  round: number;
  /** The person's comment that the executor applied to this round, if a comment did. */
  feedbackChannel: "answer" | "rework" | "defect" | null;
  feedbackBody: string | null;
  /** A result was refused before this round began: a rejected verification, an
   * invalidated phase, or a merge the card's own work broke. */
  refusedPreviousResult: boolean;
  /** A person moved the card back into work themselves: answered a blocker,
   * unparked it, or dragged it back to the running column. */
  humanRestart: boolean;
}

/**
 * Why the round began, and the person's own words when they started it.
 *
 * The order matters. A person's comment names the cause exactly, so it wins:
 * an answer to a blocker, or any other human move that leaves no words, means
 * the round was bought by continuing a card that had stopped (`restart`); a
 * rework or defect comment, or a refused result with no comment, means the
 * previous result did not stand (`rework`). The first round is always the
 * card's own first stretch of work. Nothing else starts a round: when a round
 * after the first has no refusal in front of it, something moved the card on,
 * and only a person can.
 */
export function classifyRoundStart(
  _evidence: StoryRoundStartEvidence,
): { trigger: StoryRoundTrigger; note: string | null } {
  return { trigger: "first_run", note: null };
}

/** The round a person is looking at when they open the card: the last one, or
 * null when the card has not run any. */
export function currentRound(_snapshot: StoryDetailSnapshot): StoryRound | null {
  return null;
}

/** One round by its serial number, or null when this card has no such round. */
export function roundByNumber(_snapshot: StoryDetailSnapshot, _round: number): StoryRound | null {
  return null;
}

export interface StoryDetailReadPort {
  readStoryDetail(cardId: string): Promise<StoryDetailReadResult>;
}

/** Reads one snapshot of the ledger for one card. Read-only: it takes no lock,
 * writes no row, and cannot move a card. */
export class LibsqlStoryDetailReadPort implements StoryDetailReadPort {
  private readonly client: Client;
  private readonly now: () => number;

  constructor(client: Client, now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  readStoryDetail(cardId: string): Promise<StoryDetailReadResult> {
    return Promise.resolve({ kind: "failed", message: `the detail of ${cardId} is not available yet` });
  }
}
