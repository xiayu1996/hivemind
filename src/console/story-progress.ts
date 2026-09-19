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
  evidence: StoryRoundStartEvidence,
): { trigger: StoryRoundTrigger; note: string | null } {
  if (evidence.round <= 1) return { trigger: "first_run", note: null };
  if (evidence.feedbackChannel === "rework" || evidence.feedbackChannel === "defect") {
    return { trigger: "rework", note: evidence.feedbackBody };
  }
  if (evidence.refusedPreviousResult) return { trigger: "rework", note: null };
  return { trigger: "restart", note: null };
}

/** The round a person is looking at when they open the card: the last one, or
 * null when the card has not run any. */
export function currentRound(snapshot: StoryProgressSnapshot): StoryProgressRound | null {
  return snapshot.rounds.at(-1) ?? null;
}

/** One round by its serial number, or null when this story has no such round. */
export function roundByNumber(snapshot: StoryProgressSnapshot, round: number): StoryProgressRound | null {
  return snapshot.rounds.find((entry) => entry.round === round) ?? null;
}

/**
 * The invariants a snapshot must satisfy to be shown, or null when it does.
 * A projection that breaks one of these is a read the screen refuses: guessing
 * which round is current, or letting a cumulative total understate its rounds,
 * is how a person ends up reading a true-looking number that is not true.
 */
export function validateSnapshot(snapshot: StoryProgressSnapshot): string | null {
  let previous = 0;
  for (const entry of snapshot.rounds) {
    if (entry.round <= previous) return "round ordinals must be unique and increasing";
    previous = entry.round;
  }
  if (!snapshot.rounds.some((entry) => entry.round === snapshot.currentRoundId)) {
    return "currentRoundId must name a round in the snapshot";
  }
  const roundCostUsd = snapshot.rounds.reduce((sum, entry) => sum + entry.costUsd, 0);
  if (snapshot.totalCostUsd < roundCostUsd - 1e-9) {
    return "totalCostUsd must cover every round's cost";
  }
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

  async readStoryProgress(storyId: string): Promise<StoryProgressReadResult> {
    try {
      const story = (await this.client.execute({
        sql: "SELECT id, title, state FROM stories WHERE id = ?",
        args: [storyId],
      })).rows[0];
      if (!story) return { kind: "not_found" };

      const runRows = (await this.client.execute({
        sql: `SELECT phase, round, started_at, ended_at
                FROM phase_runs WHERE card_id = ?
               ORDER BY round, started_at, run_id`,
        args: [storyId],
      })).rows;
      if (runRows.length === 0) return { kind: "empty", storyId };

      const runsByRound = new Map<number, PhaseRunRow[]>();
      for (const row of runRows) {
        const round = Number(row.round);
        const runs = runsByRound.get(round) ?? [];
        runs.push({
          phase: String(row.phase),
          startedAt: Number(row.started_at),
          endedAt: row.ended_at === null ? null : Number(row.ended_at),
        });
        runsByRound.set(round, runs);
      }

      const itemsByRound = await this.#itemsByRound(storyId);
      const costByRound = await this.#costByRound(storyId);
      const totalCostUsd = Number((await this.client.execute({
        sql: "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_entries WHERE card_id = ?",
        args: [storyId],
      })).rows[0]?.total ?? 0);

      const rounds: StoryProgressRound[] = [];
      for (const round of [...runsByRound.keys()].toSorted((left, right) => left - right)) {
        const runs = runsByRound.get(round)!;
        const open = runs.some((run) => run.endedAt === null);
        const items = itemsByRound.get(round) ?? [];
        const start = await this.#roundStart(storyId, round);
        rounds.push({
          round,
          trigger: start.trigger,
          triggerNote: start.note,
          phase: runs.at(-1)!.phase,
          startedAt: runs[0]!.startedAt,
          endedAt: open ? null : runs.reduce((latest, run) => Math.max(latest, run.endedAt ?? 0), 0),
          result: items.length === 0 && open ? { state: "pending" } : { state: "available", items },
          blockers: items
            .filter((item) => item.outcome === "failed")
            .map((item) => ({ scenarioId: item.scenarioId, text: item.text })),
          costUsd: costByRound.get(round) ?? 0,
        });
      }

      const state = String(story.state);
      const snapshot: StoryProgressSnapshot = {
        storyId,
        title: String(story.title),
        state,
        currentRoundId: rounds.at(-1)!.round,
        rounds,
        totalCostUsd,
        costCeilingUsd: await this.#costCeilingUsd(),
        workState: RUNNING_STORY_STATES.has(state) ? "running" : "stopped",
        generatedAt: this.now(),
      };

      const problem = validateSnapshot(snapshot);
      if (problem) return { kind: "invalid_projection", reason: problem };
      return { kind: "progress", snapshot };
    } catch {
      return { kind: "failed" };
    }
  }

  /** Every conclusion of every round, by round, oldest first. A carry-forward
   * is another round's answer and is left out. */
  async #itemsByRound(storyId: string): Promise<Map<number, StoryRoundAcceptance[]>> {
    const rows = (await this.client.execute({
      sql: `SELECT r.round AS round, r.scenario_id AS scenario_id, r.outcome AS outcome,
                   COALESCE(s.title, s.text, r.scenario_id) AS label
              FROM verify_scenario_results r
              LEFT JOIN story_specs s ON s.spec_id = r.scenario_id
             WHERE r.card_id = ? AND r.carried_from IS NULL AND r.outcome IN ('passed', 'failed')
             ORDER BY r.round, r.id`,
      args: [storyId],
    })).rows;
    const byRound = new Map<number, StoryRoundAcceptance[]>();
    for (const row of rows) {
      const round = Number(row.round);
      const items = byRound.get(round) ?? [];
      items.push({
        scenarioId: String(row.scenario_id),
        text: String(row.label),
        outcome: row.outcome === "passed" ? "passed" : "failed",
      });
      byRound.set(round, items);
    }
    return byRound;
  }

  /** What the ledger recorded against each round's own phase runs. A cost whose
   * run is not a phase run of this card -- a second review lane -- is no
   * round's, and stays in the story-wide total alone. */
  async #costByRound(storyId: string): Promise<Map<number, number>> {
    const rows = (await this.client.execute({
      sql: `SELECT p.round AS round, COALESCE(SUM(c.cost_usd), 0) AS usd
              FROM cost_entries c JOIN phase_runs p ON p.run_id = c.run_id
             WHERE p.card_id = ?
             GROUP BY p.round`,
      args: [storyId],
    })).rows;
    return new Map(rows.map((row) => [Number(row.round), Number(row.usd)]));
  }

  /** The requirement's own ceiling, or null when the store carries none. */
  async #costCeilingUsd(): Promise<number | null> {
    const row = (await this.client.execute({
      sql: "SELECT value_json FROM config_entries WHERE scope_id = 'global' AND key = 'cost.perCardUsdCeiling'",
    })).rows[0];
    if (!row) return null;
    const parsed: unknown = JSON.parse(String(row.value_json));
    return typeof parsed === "number" ? parsed : null;
  }

  /** How this round began, from the ledger's own evidence. */
  async #roundStart(storyId: string, round: number): Promise<{ trigger: StoryRoundTrigger; note: string | null }> {
    if (round <= 1) {
      return classifyRoundStart({
        round,
        feedbackChannel: null,
        feedbackBody: null,
        refusedPreviousResult: false,
        humanRestart: false,
      });
    }
    const feedback = (await this.client.execute({
      sql: `SELECT channel, body FROM human_feedback
             WHERE card_id = ? AND channel IN ('rework', 'defect')
               AND (applied_round = ? OR (applied_round IS NULL AND round = ?))
             ORDER BY COALESCE(applied_at, created_at) DESC, id DESC
             LIMIT 1`,
      args: [storyId, round, round],
    })).rows[0];
    const refused = (await this.client.execute({
      sql: "SELECT 1 AS rejected FROM verify_records WHERE card_id = ? AND round = ? AND verdict = 'rejected' LIMIT 1",
      args: [storyId, round - 1],
    })).rows.length > 0;
    return classifyRoundStart({
      round,
      feedbackChannel: feedback ? String(feedback.channel) as StoryRoundStartEvidence["feedbackChannel"] : null,
      feedbackBody: feedback ? String(feedback.body) : null,
      refusedPreviousResult: refused,
      humanRestart: true,
    });
  }
}

/** One phase run's own line, the pieces a round is assembled from. */
interface PhaseRunRow {
  phase: string;
  startedAt: number;
  endedAt: number | null;
}

/** The states a card can be in while work is still moving. Everything else is a
 * card that has stopped, which is a fact about the card and never about its
 * spend. */
const RUNNING_STORY_STATES: ReadonlySet<string> = new Set([
  "QUEUED", "SHAPE", "DESIGN", "SPECIFY", "CODE", "VERIFY", "MERGE", "REGRESSION_FIX",
]);

/**
 * The one read route. It maps each read answer to a status a client can act on
 * and never returns another card's data in place of the one asked for.
 */
export function registerStoryProgressRoute(app: FastifyInstance, port: StoryProgressReadPort): void {
  app.get(STORY_PROGRESS_API_PATH, async (request, reply) => {
    const storyId = String((request.params as { storyId?: string }).storyId ?? "");
    const result = await port.readStoryProgress(storyId);
    switch (result.kind) {
      case "progress":
        return reply.code(200).send(result.snapshot);
      case "empty":
        return reply.code(200).send({ kind: "empty", storyId: result.storyId });
      case "not_found":
        return reply.code(404).send({ error: "story not found" });
      case "invalid_projection":
        return reply.code(502).send({ error: "story progress is not consistent", reason: result.reason });
      case "failed":
        return reply.code(503).send({ error: "story progress is unavailable" });
    }
  });
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
  action: StoryProgressViewAction,
): StoryProgressViewState {
  switch (action.type) {
    case "load":
      return { ...state, status: "loading", requestId: state.requestId + 1 };
    case "select":
      return { ...state, selectedRoundId: action.round };
    case "loaded":
      if (action.requestId !== state.requestId) return state;
      switch (action.result.kind) {
        case "progress":
          return { ...state, status: "ready", snapshot: action.result.snapshot };
        case "empty":
          return { ...state, status: "empty", snapshot: null };
        default:
          return { ...state, status: "error" };
      }
  }
}

/** The round the screen is showing: the picked one, or the current one. Null
 * while nothing has been read, or in the empty state. */
export function selectedRoundOf(state: StoryProgressViewState): StoryProgressRound | null {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  if (state.selectedRoundId === null) return currentRound(snapshot);
  return roundByNumber(snapshot, state.selectedRoundId);
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
  currentRunEntry: "当前",
  overLimitStatus: "已超限",
  workContinues: "工作仍继续",
  workStopped: "工作已停止",
  noBlocker: "卡点：无",
  triggerFirstRun: "首次工作",
  triggerRework: "返工",
  triggerRestart: "重新开始",
} as const;

const TRIGGER_COPY: Readonly<Record<StoryRoundTrigger, string>> = {
  first_run: STORY_PROGRESS_COPY.triggerFirstRun,
  rework: STORY_PROGRESS_COPY.triggerRework,
  restart: STORY_PROGRESS_COPY.triggerRestart,
};

/** `第 2 轮`, and `当前轮` for the round the card is in. */
export function formatRoundLabel(round: number, currentRoundId: number): string {
  return round === currentRoundId ? STORY_PROGRESS_COPY.currentRoundTab : `第 ${round} 轮`;
}

/** The heading of a round's own panel: `当前轮阶段与结果` for the current
 * round, `第 2 轮` for an older one. */
export function formatRoundPanelHeading(round: number, currentRoundId: number): string {
  return round === currentRoundId ? STORY_PROGRESS_COPY.currentRoundPanelHeading : `第 ${round} 轮`;
}

/** `触发原因：重新开始`, from the round's own recorded cause, never a guess. */
export function formatRoundTriggerLine(round: StoryProgressRound): string {
  return `触发原因：${TRIGGER_COPY[round.trigger]}`;
}

/** `阶段：VERIFY`: the phase this round reached. */
export function formatRoundPhaseLine(round: StoryProgressRound): string {
  return `阶段：${round.phase}`;
}

/** `已取得的结果：3 项验收已通过`, counted from the round's own results. A round
 * that has not concluded anything yet says so instead, never `0 项`. */
export function formatRoundResultLine(round: StoryProgressRound): string {
  if (round.result.state === "pending") return STORY_PROGRESS_COPY.resultsPending;
  const passed = round.result.items.filter((item) => item.outcome === "passed").length;
  return `已取得的结果：${passed} 项验收已通过`;
}

/** `卡点：1 项验收未通过`, counted from the round's own blockers, or `卡点：无`.
 * A read that failed is never one of these. */
export function formatRoundBlockerLine(round: StoryProgressRound): string {
  return round.blockers.length === 0 ? STORY_PROGRESS_COPY.noBlocker : `卡点：${round.blockers.length} 项验收未通过`;
}

/** `$1.24（本需求当前轮）`: the amount and the scope it covers, never one
 * without the other. */
export function formatRoundCostValue(round: StoryProgressRound, currentRoundId: number): string {
  const amount = `$${round.costUsd.toFixed(2)}`;
  return round.round === currentRoundId
    ? `${amount}（本需求当前轮）`
    : `${amount}（本需求第 ${round.round} 轮）`;
}

/** `$3.80（本需求全部轮次）`: every recorded cost of this story, marked as a
 * different statistic from one round's. */
export function formatTotalCostValue(totalUsd: number): string {
  return `$${totalUsd.toFixed(2)}（本需求全部轮次）`;
}

/** Whether the spend ceiling is reached. `over` is a fact about money only. */
export function limitStateOf(snapshot: StoryProgressSnapshot): "normal" | "over" {
  if (snapshot.costCeilingUsd === null) return "normal";
  return snapshot.totalCostUsd > snapshot.costCeilingUsd ? "over" : "normal";
}

/** `上限 $10.00`, or null when no ceiling is in force. */
export function formatLimitLine(snapshot: StoryProgressSnapshot): string | null {
  return snapshot.costCeilingUsd === null ? null : `上限 $${snapshot.costCeilingUsd.toFixed(2)}`;
}

/** `已超限`, or null while the card is under its ceiling. */
export function formatLimitStateLine(snapshot: StoryProgressSnapshot): string | null {
  return limitStateOf(snapshot) === "over" ? STORY_PROGRESS_COPY.overLimitStatus : null;
}

/** `工作仍继续` while work is moving; never the word `已暂停`, which states the
 * card stopped when the only fact is that it spent. */
export function formatWorkStateLine(snapshot: StoryProgressSnapshot): string {
  return snapshot.workState === "running" ? STORY_PROGRESS_COPY.workContinues : STORY_PROGRESS_COPY.workStopped;
}
