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
  evidence: StoryRoundStartEvidence,
): { trigger: StoryRoundTrigger; note: string | null } {
  if (evidence.round <= 1) return { trigger: "first_run", note: null };
  if (evidence.feedbackChannel === "rework" || evidence.feedbackChannel === "defect") {
    return { trigger: "rework", note: evidence.feedbackBody };
  }
  if (evidence.feedbackChannel === "answer") return { trigger: "restart", note: null };
  if (evidence.refusedPreviousResult) return { trigger: "rework", note: null };
  return { trigger: "restart", note: null };
}

/** The round a person is looking at when they open the card: the last one, or
 * null when the card has not run any. */
export function currentRound(snapshot: StoryDetailSnapshot): StoryRound | null {
  return snapshot.rounds.at(-1) ?? null;
}

/** One round by its serial number, or null when this card has no such round. */
export function roundByNumber(snapshot: StoryDetailSnapshot, round: number): StoryRound | null {
  return snapshot.rounds.find((entry) => entry.round === round) ?? null;
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

  async readStoryDetail(cardId: string): Promise<StoryDetailReadResult> {
    try {
      const story = (
        await this.client.execute({
          sql: "SELECT id, title, state FROM stories WHERE id = ?",
          args: [cardId],
        })
      ).rows[0];
      if (!story) return { kind: "not_found" };

      const [runRows, acceptanceRows, roundCostRows, totalCostRow, feedbackRows, rejectionRows, refusalEventRows] =
        await Promise.all([
          this.client.execute({
            sql: `SELECT round, run_id, phase, started_at, ended_at FROM phase_runs
                   WHERE card_id = ? ORDER BY round, started_at, run_id`,
            args: [cardId],
          }),
          this.client.execute({
            // This round's own conclusions, never the carry-forwards of them: a
            // carried row repeats an earlier round's result, and counting it
            // again would move that result into the round that copied it.
            sql: `SELECT v.round AS round, v.scenario_id AS scenario_id, v.outcome AS outcome,
                         COALESCE(s.title, v.scenario_id) AS text
                   FROM verify_scenario_results v
                   LEFT JOIN story_specs s ON s.story_id = v.card_id AND s.spec_id = v.scenario_id
                   WHERE v.card_id = ? AND v.carried_from IS NULL
                   ORDER BY v.round, COALESCE(s.seq, v.id), v.id`,
            args: [cardId],
          }),
          this.client.execute({
            sql: `SELECT r.round AS round, SUM(c.cost_usd) AS usd
                   FROM cost_entries c
                   JOIN phase_runs r ON r.run_id = c.run_id
                   WHERE r.card_id = ?
                   GROUP BY r.round`,
            args: [cardId],
          }),
          this.client.execute({
            sql: "SELECT SUM(cost_usd) AS usd FROM cost_entries WHERE card_id = ?",
            args: [cardId],
          }),
          this.client.execute({
            sql: `SELECT applied_round AS round, channel, body FROM human_feedback
                   WHERE card_id = ? AND applied_round IS NOT NULL
                   ORDER BY applied_round, created_at, id`,
            args: [cardId],
          }),
          this.client.execute({
            sql: `SELECT round FROM verify_records WHERE card_id = ? AND verdict = 'rejected'`,
            args: [cardId],
          }),
          this.client.execute({
            sql: `SELECT ts FROM event_log
                   WHERE card_id = ? AND type IN ('phase.invalidated','merge.conflict','merge.verification_failed')
                   ORDER BY ts, id`,
            args: [cardId],
          }),
        ]);

      const runsByRound = new Map<
        number,
        Array<{ runId: string; phase: string; startedAt: number; endedAt: number | null }>
      >();
      for (const row of runRows.rows) {
        const round = Number(row.round);
        const list = runsByRound.get(round) ?? [];
        list.push({
          runId: String(row.run_id),
          phase: String(row.phase),
          startedAt: Number(row.started_at),
          endedAt: row.ended_at === null ? null : Number(row.ended_at),
        });
        runsByRound.set(round, list);
      }

      const acceptanceByRound = new Map<number, StoryRoundAcceptance[]>();
      for (const row of acceptanceRows.rows) {
        const round = Number(row.round);
        const list = acceptanceByRound.get(round) ?? [];
        list.push({
          scenarioId: String(row.scenario_id),
          text: String(row.text),
          outcome: String(row.outcome) === "failed" ? "failed" : "passed",
        });
        acceptanceByRound.set(round, list);
      }

      const costByRound = new Map<number, number>();
      for (const row of roundCostRows.rows) {
        costByRound.set(Number(row.round), Number(row.usd ?? 0));
      }

      // The comment the executor applied to a round. Rows are read oldest
      // first, so the last one written wins: that is the comment a person saw
      // land, and the one that names the round.
      const feedbackByRound = new Map<number, { channel: StoryRoundStartEvidence["feedbackChannel"]; body: string | null }>();
      for (const row of feedbackRows.rows) {
        const channel = String(row.channel);
        feedbackByRound.set(Number(row.round), {
          channel:
            channel === "answer" || channel === "rework" || channel === "defect" ? channel : null,
          body: row.body === null ? null : String(row.body),
        });
      }

      const rejectedRounds = new Set(rejectionRows.rows.map((row) => Number(row.round)));
      const refusalEvents = refusalEventRows.rows.map((row) => Number(row.ts));

      const roundNumbers = [...runsByRound.keys()].toSorted((a, b) => a - b);
      const rounds: StoryRound[] = [];
      for (let index = 0; index < roundNumbers.length; index += 1) {
        const round = roundNumbers[index]!;
        const runs = [...runsByRound.get(round)!].toSorted((a, b) =>
          a.startedAt !== b.startedAt ? a.startedAt - b.startedAt : a.runId.localeCompare(b.runId),
        );
        const first = runs[0]!;
        const last = runs[runs.length - 1]!;
        const open = runs.some((run) => run.endedAt === null);
        const endedAt = open
          ? null
          : runs.reduce<number | null>((latest, run) => {
              const end = run.endedAt;
              if (end === null) return latest;
              return latest === null || end > latest ? end : latest;
            }, null);

        const previous = index > 0 ? runsByRound.get(roundNumbers[index - 1]!)! : null;
        const refusedPreviousResult =
          previous !== null &&
          (rejectedRounds.has(roundNumbers[index - 1]!) ||
            (() => {
              const from = Math.min(...previous.map((run) => run.startedAt));
              return refusalEvents.some((ts) => ts >= from && ts <= first.startedAt);
            })());
        const feedback = feedbackByRound.get(round);
        const { trigger, note } = classifyRoundStart({
          round,
          feedbackChannel: feedback?.channel ?? null,
          feedbackBody: feedback?.body ?? null,
          refusedPreviousResult,
          humanRestart: false,
        });

        const acceptance = acceptanceByRound.get(round) ?? [];
        rounds.push({
          round,
          trigger,
          triggerNote: note,
          phase: last.phase,
          startedAt: first.startedAt,
          endedAt,
          resultPending: open && acceptance.length === 0,
          acceptance,
          costUsd: costByRound.get(round) ?? 0,
        });
      }

      return {
        kind: "ok",
        snapshot: {
          cardId,
          title: String(story.title),
          state: String(story.state),
          rounds,
          totalCostUsd: Number(totalCostRow.rows[0]?.usd ?? 0),
          generatedAt: this.now(),
        },
      };
    } catch (cause) {
      return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
    }
  }
}
