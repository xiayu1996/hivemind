import { createHash } from "node:crypto";
import type { StorySection } from "../notion/blocks/story-page.js";
import type { Client } from "@libsql/client";
import { redactForExport } from "../observability/redact.js";
import {
  assertStoryTransition,
  storyTransitionStatement,
  isForwardStoryTransition,
  type StoryState,
  type StoryStopReason,
  type TransitionActor,
} from "./state-machine.js";
import type { PhaseInput, PhaseRejection, RegressionCardRef, ScenarioFailure } from "../pipeline/phase-input.js";
import { parseDoD, type DefinitionOfDone } from "../pipeline/dod.js";
import { dodVersion, scenarioVersions } from "../pipeline/dod-version.js";
import { isProviderFault } from "../pipeline/failure-classification.js";
import {
  diagnosisFor,
  type StopSummary,
  type StopSummaryBaselineFailure,
  type StopSummaryDispatchFailure,
  type StopSummaryMergeBounce,
} from "./stop-summary.js";
import type { ConvergenceClassification } from "../pipeline/convergence.js";

export type { StoryPhase } from "../pipeline/phase.js";
import type { StoryPhase } from "../pipeline/phase.js";

/** A child process's stderr; long enough to carry a stack, short enough that
 * one dead run cannot fill the event log. */
const DISPATCH_FAILURE_MESSAGE_LIMIT = 4000;

/**
 * What the merge re-verification found, kept apart from the prose reason so
 * the next CODE round can be written from the names rather than from the tail
 * of a log.
 */
export interface MergeRejectionDetail {
  attribution?: "story_regression" | "baseline_failing" | "environment";
  /** Paths the rebase could not reconcile, sorted. */
  conflictedFiles?: readonly string[];
  failures?: readonly string[];
  failedChecks?: readonly string[];
  baseRevision?: string;
  candidateRevision?: string;
}

export interface StoryIntake {
  id: string;
  epicId?: string;
  notionPageId: string;
  title: string;
  requirement: string;
  repo?: string;
  branch?: string;
  targetBranch?: string;
  priority?: number;
  capabilities?: string[];
}

export interface StorySnapshot extends StoryIntake {
  state: StoryState;
  phase: StoryPhase | null;
  innerLoopRounds: number;
  phaseReentries: number;
  /** How many times the regression loop has dragged the delivered Story back. */
  regressionReopens: number;
  /** When a person last acted on the card; the inner loop budget restarts from there. */
  lastHumanActionAt: number | null;
  stopReason: string | null;
  mrUrl: string | null;
  resumeState: StoryState | null;
}

export interface HumanStoryTransitionInput {
  cardId: string;
  expectedFrom: StoryState;
  to: StoryState;
  observedAiStatus: string;
  humanWinsUntil: number;
  runId: string;
  parkedResumeState?: StoryState;
}

export interface BeginPhaseInput {
  runId: string;
  cardId: string;
  phase: StoryPhase;
  round: number;
  prompt: string;
}

export interface CompletePhaseInput {
  runId: string;
  sessionId: string;
  artifacts: Array<{ kind: string; body: string }>;
}

export interface ScenarioConclusion {
  scenarioId: string;
  /** The round the conclusion belongs to. */
  round: number;
  outcome: "passed" | "failed" | "inconclusive";
  scenarioVersion: string;
  verifiedTreeSha: string;
  /** Present when the row was carried forward rather than verified again. */
  carriedFrom?: number;
}

export interface VerificationRecordInput {
  cardId: string;
  round: number;
  /**
   * The scenarios this round actually verified.
   *
   * It has to be passed in, because "everything not named as failed passed" is
   * only true while every round verifies the whole card. Once a single reworded
   * scenario can be re-verified on its own, that rule silently marks every
   * other scenario as passed on evidence nobody produced.
   */
  verifiedScenarios?: readonly string[];
  /** The tree the conclusions are about. */
  verifiedTreeSha?: string;
  codeSessionId: string;
  verifySessionId: string;
  verdict: "accepted" | "rejected" | "inconclusive";
  failedScenarios: string[];
  evidenceDir?: string;
  screenshots?: Array<{ scenarioId: string; path: string }>;
}

export interface PersistedPhaseResult {
  sessionId: string;
  artifacts: Array<{ kind: string; body: string }>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} is not a number`);
  return value;
}

function eventStatement(
  runId: string,
  cardId: string,
  phase: string | null,
  type: string,
  data: unknown,
  time: number,
): { sql: string; args: Array<string | number | null> } {
  return {
    sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
          VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                  ?, ?, ?, ?, ?)`,
    args: [runId, runId, cardId, phase, type, time, JSON.stringify(data)],
  };
}

/** Central execution truth used to reconstruct a Story without local session state. */
/**
 * Proof that the caller still owns the card. Every write a worker makes on a
 * card's behalf passes through it, because the lease is what stops two
 * executions from both advancing the same card and, until it was wired here,
 * nothing outside `lease.ts` had ever looked at a fence -- a revoked worker
 * that came back could still write state.
 *
 * Absent for the orchestrator and for a person's own commands: neither holds a
 * card lease, and neither is a second executor.
 */
export interface CardWriteGuard {
  assert(cardId: string): Promise<void>;
}

export class StoryExecutionStore {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
    private readonly writeGuard?: CardWriteGuard,
  ) {}

  /** Checked before every system-actor write on a card. */
  private async guard(cardId: string): Promise<void> {
    await this.writeGuard?.assert(cardId);
  }

  /** The Epic id behind an Epic page, for a card a person filed by relation. */
  async epicIdForPage(notionPageId: string): Promise<string | undefined> {
    const row = (await this.client.execute({
      sql: "SELECT id FROM epics WHERE notion_page_id = ?",
      args: [notionPageId],
    })).rows[0];
    return row ? String(row.id) : undefined;
  }

  /**
   * Files an already-known Story under its Epic. Intake creates a card once
   * and never rewrites it, so a relation set after the card was ingested --
   * or before this was read at all -- would otherwise never arrive. Only an
   * unset epic_id is filled: a Story the decomposer placed keeps its Epic.
   */
  async attachEpic(cardId: string, epicId: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE stories SET epic_id = ?, updated_at = ? WHERE id = ? AND epic_id IS NULL",
      args: [epicId, this.now(), cardId],
    });
  }

  async createStory(input: StoryIntake): Promise<boolean> {
    if (input.requirement.trim() === "") throw new Error("Story requirement must not be empty");
    const time = this.now();
    const [insert] = await this.client.batch([
      {
        sql: `INSERT OR IGNORE INTO stories
                (id, epic_id, notion_page_id, title, requirement, state, phase, priority, repo, branch,
                 target_branch, capabilities, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'QUEUED', NULL, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          input.id,
          input.epicId ?? null,
          input.notionPageId,
          input.title,
          input.requirement,
          input.priority ?? 2,
          input.repo ?? null,
          input.branch ?? null,
          input.targetBranch ?? null,
          JSON.stringify([...(input.capabilities ?? [])].toSorted()),
          time,
          time,
        ],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, 0, ?, NULL, 'story.intake', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM stories WHERE id = ? AND notion_page_id = ? AND created_at = ?
              ) AND NOT EXISTS (
                SELECT 1 FROM event_log WHERE run_id = ?
              )`,
        args: [
          `intake:${input.id}`,
          input.id,
          time,
          JSON.stringify({ notionPageId: input.notionPageId }),
          input.id,
          input.notionPageId,
          time,
          `intake:${input.id}`,
        ],
      },
    ], "write");
    return insert?.rowsAffected === 1;
  }

  async getStory(cardId: string): Promise<StorySnapshot> {
    const result = await this.client.execute({
      sql: `SELECT id, epic_id, notion_page_id, title, requirement, state, phase, repo, branch,
                   target_branch, mr_url, resume_state,
                   inner_loop_rounds, phase_reentries, regression_reopens, stop_reason, last_human_action_at
            FROM stories WHERE id = ?`,
      args: [cardId],
    });
    const row = result.rows[0];
    if (!row) throw new Error(`Story does not exist: ${cardId}`);
    return {
      id: stringValue(row.id, "Story id"),
      ...(optionalString(row.epic_id) ? { epicId: optionalString(row.epic_id)! } : {}),
      notionPageId: stringValue(row.notion_page_id, "Notion page id"),
      title: stringValue(row.title, "Story title"),
      requirement: stringValue(row.requirement, "Story requirement"),
      state: stringValue(row.state, "Story state") as StoryState,
      phase: optionalString(row.phase) as StoryPhase | null,
      innerLoopRounds: numberValue(row.inner_loop_rounds, "inner-loop rounds"),
      phaseReentries: numberValue(row.phase_reentries, "phase reentries"),
      regressionReopens: numberValue(row.regression_reopens, "regression reopens"),
      lastHumanActionAt: row.last_human_action_at === null || row.last_human_action_at === undefined
        ? null
        : Number(row.last_human_action_at),
      stopReason: optionalString(row.stop_reason),
      mrUrl: optionalString(row.mr_url),
      resumeState: optionalString(row.resume_state) as StoryState | null,
      ...(optionalString(row.repo) ? { repo: optionalString(row.repo)! } : {}),
      ...(optionalString(row.branch) ? { branch: optionalString(row.branch)! } : {}),
      ...(optionalString(row.target_branch) ? { targetBranch: optionalString(row.target_branch)! } : {}),
    };
  }

  async transition(
    cardId: string,
    expectedFrom: StoryState,
    to: StoryState,
    actor: TransitionActor,
    runId: string,
    parkedResumeState?: StoryState,
  ): Promise<void> {
    assertStoryTransition(expectedFrom, to, actor, parkedResumeState);
    if (actor === "system") await this.guard(cardId);
    // A person sending the Story back to SHAPE wants the acceptance contract
    // written again, not the frozen result handed back.
    if (actor === "human" && to === "SHAPE") await this.resetForRedesign(cardId, `${actor} moved the Story to SHAPE`);
    const time = this.now();
    const [update] = await this.client.batch([
      {
        // The crash counter is cleared by progress. A run that died in SHAPE
        // says nothing about whether DESIGN will run, so carrying the count
        // across phases turned three unrelated crashes in a card's life into a
        // stop. Moving forward is the proof that the phase the count belonged
        // to is over; a card bouncing between two phases never earns it.
        //
        // A transition a person made is also the moment the inner-loop budget
        // starts again: the budget counts the rounds failed since somebody last
        // acted on the card, so without this stamp a resume grants a reentry
        // budget and no rounds to use it in. The reentry count is cleared for
        // the same reason `applyHumanTransition` clears it: a card parked on
        // its retry budget has spent every reentry, so a person who answers
        // and does not get the count back watches it park again on the next
        // failure. Answering in Notion arrives here rather than there, so
        // leaving it out made the door people actually use the broken one.
        sql: `UPDATE stories
              SET state = ?, phase = ?, stop_reason = NULL, resume_state = NULL,
                  phase_reentries = CASE WHEN ? THEN 0 ELSE phase_reentries END,
                  last_human_action_at = CASE WHEN ? THEN ? ELSE last_human_action_at END,
                  updated_at = ?
              WHERE id = ? AND state = ?`,
        args: [
          to,
          phaseForState(to),
          (actor === "human" && expectedFrom === "NEEDS_INPUT")
            || (actor === "system" && isForwardStoryTransition(expectedFrom, to)) ? 1 : 0,
          actor === "human" ? 1 : 0,
          time,
          time,
          cardId,
          expectedFrom,
        ],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                     ?, ?, 'story.transition', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM stories WHERE id = ? AND state = ? AND updated_at = ?
              )`,
        args: [
          runId,
          runId,
          cardId,
          phaseForState(to),
          time,
          JSON.stringify({ from: expectedFrom, to, actor }),
          cardId,
          to,
          time,
        ],
      },
    ], "write");
    if (update?.rowsAffected !== 1) {
      throw new Error(`Story transition lost a race: ${cardId} is no longer ${expectedFrom}`);
    }
  }

  async applyHumanTransition(input: HumanStoryTransitionInput): Promise<void> {
    assertStoryTransition(
      input.expectedFrom,
      input.to,
      "human",
      input.parkedResumeState,
    );
    const time = this.now();
    if (!Number.isFinite(input.humanWinsUntil) || input.humanWinsUntil < time) {
      throw new Error("human-wins deadline must not be in the past");
    }
    const resumeState = input.to === "HUMAN_PARKED"
      ? input.expectedFrom
      : null;
    // A person resuming a Story that stopped on its retry budget grants a new
    // budget; otherwise the very next failure would stop it again.
    const resetReentries = input.expectedFrom === "NEEDS_INPUT" && input.to !== "HUMAN_PARKED";
    if (input.to === "SHAPE") await this.resetForRedesign(input.cardId, "a person moved the Story to SHAPE");
    const [update] = await this.client.batch([
      {
        sql: `UPDATE stories
              SET state = ?, phase = ?, stop_reason = NULL, resume_state = ?,
                  notion_ai_status_shadow = ?, human_wins_until = ?,
                  phase_reentries = CASE WHEN ? THEN 0 ELSE phase_reentries END,
                  last_human_action_at = ?, updated_at = ?
              WHERE id = ? AND state = ?`,
        args: [
          input.to,
          phaseForState(input.to),
          resumeState,
          input.observedAiStatus,
          input.humanWinsUntil,
          resetReentries ? 1 : 0,
          time,
          time,
          input.cardId,
          input.expectedFrom,
        ],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, 0, ?, ?, 'story.human_transition', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM stories WHERE id = ? AND state = ? AND updated_at = ?
              )`,
        args: [
          input.runId,
          input.cardId,
          phaseForState(input.to),
          time,
          JSON.stringify({
            from: input.expectedFrom,
            to: input.to,
            observedAiStatus: input.observedAiStatus,
            humanWinsUntil: input.humanWinsUntil,
          }),
          input.cardId,
          input.to,
          time,
        ],
      },
    ], "write");
    if (update?.rowsAffected !== 1) {
      throw new Error(`Human Story transition lost a race: ${input.cardId} is no longer ${input.expectedFrom}`);
    }
  }

  async beginPhase(input: BeginPhaseInput): Promise<{ attempt: number }> {
    await this.guard(input.cardId);
    if (input.round < 1 || !Number.isInteger(input.round)) throw new Error("phase round must be a positive integer");
    const story = await this.getStory(input.cardId);
    // The regression loop verifies without leaving REGRESSION_FIX: the Story
    // is not back in its inner loop, it is a delivered Story being repaired.
    const stateForPhase = input.phase === "VERIFY" && story.state === "REGRESSION_FIX" ? "REGRESSION_FIX" : input.phase;
    if (story.state !== stateForPhase) {
      throw new Error(`cannot start ${input.phase} while Story is ${story.state}`);
    }
    const time = this.now();
    const promptSha256 = createHash("sha256").update(input.prompt).digest("hex");
    const results = await this.client.batch([
      // Supersedes a previous attempt in the same phase slot when it failed or
      // was left running by a crash. The old row is deleted (its artifacts
      // cascade away) because run_id is the primary key that artifacts
      // reference; the attempt history survives in event_log. Completed runs
      // stay immutable and are reused through getCompletedPhase.
      {
        // Carries the same guard as the insert below: a start the Story's state
        // rejects must delete nothing, and the batch commits either way.
        sql: `DELETE FROM phase_runs
              WHERE card_id = ? AND phase = ? AND round = ? AND status <> 'completed'
                AND EXISTS (SELECT 1 FROM stories WHERE id = card_id AND state = ?)`,
        args: [input.cardId, input.phase, input.round, stateForPhase],
      },
      {
        sql: `INSERT INTO phase_runs
                (run_id, card_id, phase, round, prompt_sha256, status, started_at)
              SELECT ?, id, ?, ?, ?, 'running', ? FROM stories
              WHERE id = ? AND state = ?
                AND NOT EXISTS (
                  SELECT 1 FROM phase_runs WHERE card_id = id AND phase = ? AND round = ?
                )`,
        args: [input.runId, input.phase, input.round, promptSha256, time, input.cardId, stateForPhase,
          input.phase, input.round],
      },
      eventStatement(input.runId, input.cardId, input.phase, "phase.enter", {
        round: input.round,
        promptSha256,
      }, time),
      // The prompt for this run has just been written, so everything a person
      // added that the prompt carries has now been used -- which is the moment
      // the card page may say so.
      {
        sql: `UPDATE human_feedback SET applied_at = ?, applied_round = ?
               WHERE card_id = ? AND applied_at IS NULL AND channel IN ('preference', 'unclassified')`,
        args: [time, input.round, input.cardId],
      },
    ], "write");
    const inserted = Number(results[1]?.rowsAffected ?? 0);
    if (inserted !== 1) {
      throw new Error(`cannot start ${input.phase} while Story is not in that phase`);
    }
    // How many times this exact slot has been entered, counted from the event
    // log because `phase_runs` keeps only the live attempt. Callers use it to
    // give each attempt its own session file: failover, crash recovery and a
    // contract that had to be asked for twice all run the same (phase, round)
    // more than once, and a second attempt writing into the first one's session
    // would be the session fork the whole design forbids.
    const attempts = (await this.client.execute({
      sql: `SELECT COUNT(*) AS attempts FROM event_log
             WHERE card_id = ? AND phase = ? AND type = 'phase.enter'
               AND json_extract(data, '$.round') = ?`,
      args: [input.cardId, input.phase, input.round],
    })).rows[0];
    return { attempt: Math.max(1, Number(attempts?.attempts ?? 1)) };
  }

  async completePhase(input: CompletePhaseInput): Promise<void> {
    if (input.sessionId.length === 0) throw new Error("phase session id must not be empty");
    if (input.artifacts.length === 0) throw new Error("a completed phase must persist at least one artifact");
    for (const artifact of input.artifacts) {
      if (artifact.kind.trim() === "" || artifact.body.trim() === "") {
        throw new Error("phase artifact kind and body must not be empty");
      }
    }
    const time = this.now();
    const run = await this.client.execute({
      sql: "SELECT card_id, phase, round, status FROM phase_runs WHERE run_id = ?",
      args: [input.runId],
    });
    const row = run.rows[0];
    if (!row) throw new Error(`phase run does not exist: ${input.runId}`);
    if (row.status !== "running") throw new Error(`phase run is already ${String(row.status)}`);
    const cardId = stringValue(row.card_id, "phase card id");
    const phase = stringValue(row.phase, "phase");
    const round = numberValue(row.round, "phase round");
    const statements = input.artifacts.map((artifact) => ({
          sql: `INSERT INTO phase_artifacts
                  (run_id, card_id, phase, round, kind, body, created_at)
                SELECT run_id, card_id, phase, round, ?, ?, ? FROM phase_runs
                WHERE run_id = ? AND status = 'running'`,
          args: [artifact.kind, artifact.body, time, input.runId],
        }));
    const results = await this.client.batch([
      ...statements,
      {
        sql: `UPDATE phase_runs
              SET session_id = ?, status = 'completed', ended_at = ?
              WHERE run_id = ? AND status = 'running'`,
        args: [input.sessionId, time, input.runId],
      },
      eventStatement(
        input.runId,
        cardId,
        phase,
        "phase.exit",
        { round, artifactKinds: input.artifacts.map((artifact) => artifact.kind).toSorted() },
        time,
      ),
    ], "write");
    if (results.at(-2)?.rowsAffected !== 1) throw new Error(`phase run is no longer running: ${input.runId}`);
  }

  async failPhase(runId: string, failure: string): Promise<void> {
    const time = this.now();
    const run = await this.client.execute({
      sql: "SELECT card_id, phase, round, status FROM phase_runs WHERE run_id = ?",
      args: [runId],
    });
    const row = run.rows[0];
    if (!row) throw new Error(`phase run does not exist: ${runId}`);
    if (row.status !== "running") throw new Error(`phase run is already ${String(row.status)}`);
    const [update] = await this.client.batch([
      {
        sql: `UPDATE phase_runs SET status = 'failed', failure = ?, ended_at = ?
              WHERE run_id = ? AND status = 'running'`,
        args: [failure, time, runId],
      },
      eventStatement(
        runId,
        stringValue(row.card_id, "phase card id"),
        stringValue(row.phase, "phase"),
        "phase.failed",
        { round: row.round, failure },
        time,
      ),
    ], "write");
    if (update?.rowsAffected !== 1) throw new Error(`phase run is no longer running: ${runId}`);
  }

  async getCompletedPhase(
    cardId: string,
    phase: StoryPhase,
    round: number,
  ): Promise<PersistedPhaseResult | null> {
    const run = (await this.client.execute({
      sql: `SELECT run_id, session_id, status FROM phase_runs
            WHERE card_id = ? AND phase = ? AND round = ?`,
      args: [cardId, phase, round],
    })).rows[0];
    // A failed or crash-orphaned running slot has no reusable result; the
    // caller re-runs the phase and beginPhase supersedes the stale attempt.
    if (!run || run.status !== "completed") return null;
    if (typeof run.session_id !== "string") {
      throw new Error(`completed ${phase} round ${round} has no session id`);
    }
    const artifacts = (await this.client.execute({
      sql: "SELECT kind, body FROM phase_artifacts WHERE run_id = ? ORDER BY kind",
      args: [String(run.run_id)],
    })).rows.map((row) => ({
      kind: stringValue(row.kind, "artifact kind"),
      body: stringValue(row.body, "artifact body"),
    }));
    if (artifacts.length === 0) throw new Error(`completed ${phase} round ${round} has no artifacts`);
    return { sessionId: run.session_id, artifacts };
  }

  /** Failed sets of the rounds recorded after `since` (a person's last action
   * on the card, so a resume starts a fresh inner loop), oldest first. */
  /**
   * A failure of the pipeline rather than of the Story. It is recorded on the
   * card so the reflection pipeline can count patterns per repository (03
   * section 4); nothing consumes it yet.
   */
  async recordFriction(input: {
    cardId: string;
    runId: string;
    kind: string;
    detail: string;
  }): Promise<void> {
    const time = this.now();
    await this.client.batch([
      eventStatement(input.runId, input.cardId, null, "friction.recorded", {
        kind: input.kind,
        detail: input.detail,
      }, time),
    ], "write");
  }

  /**
   * The rounds the convergence criterion may compare: rejected ones only. A
   * round recorded as inconclusive was lost to the environment and says
   * nothing about whether the failing set is shrinking, so it must not be
   * charged to the budget here either — the resume path reads this, not the
   * in-memory loop (03 section 8.6).
   */
  async getVerificationFailureHistory(cardId: string, since = 0): Promise<string[][]> {
    const rows = (await this.client.execute({
      sql: `SELECT failed_scenarios FROM verify_records
            WHERE card_id = ? AND created_at > ? AND verdict = 'rejected'
            ORDER BY round`,
      args: [cardId, since],
    })).rows;
    return rows.map((row) => parseStringArray(row.failed_scenarios, "failed scenarios"));
  }

  async getDefinitionOfDone(cardId: string): Promise<DefinitionOfDone> {
    const row = (await this.client.execute({
      sql: `SELECT body FROM phase_artifacts
            WHERE card_id = ? AND phase = 'SHAPE' AND kind = 'dod'
            ORDER BY round DESC, id DESC LIMIT 1`,
      args: [cardId],
    })).rows[0];
    if (!row) throw new Error(`Story has no persisted Definition of Done: ${cardId}`);
    return parseDoD(stringValue(row.body, "Definition of Done"));
  }

  /** The frozen setpoint, or null when SHAPE has not produced one yet. */
  async findFrozenDefinitionOfDone(cardId: string): Promise<DefinitionOfDone | null> {
    const frozen = await this.client.execute({
      sql: "SELECT COUNT(*) AS count FROM story_specs WHERE story_id = ?",
      args: [cardId],
    });
    if (Number(frozen.rows[0]?.count) === 0) return null;
    return this.getDefinitionOfDone(cardId);
  }

  async recordVerification(runId: string, input: VerificationRecordInput): Promise<void> {
    const time = this.now();
    const declared = new Set((await this.client.execute({
      sql: "SELECT spec_id FROM story_specs WHERE story_id = ?",
      args: [input.cardId],
    })).rows.map((row) => stringValue(row.spec_id, "spec id")));
    for (const failed of input.failedScenarios) {
      if (!declared.has(failed)) throw new Error(`verification references undeclared scenario: ${failed}`);
    }
    const failed = [...new Set(input.failedScenarios)].toSorted();
    // Only the scenarios this round looked at change status. Defaulting to the
    // whole card keeps the behaviour of a full verification round, which is
    // what every round is until a partial re-verification asks for one.
    const verified = [...new Set(input.verifiedScenarios ?? [...declared])].toSorted();
    for (const id of verified) {
      if (!declared.has(id)) throw new Error(`verification references undeclared scenario: ${id}`);
    }
    const failedSet = new Set(failed);
    const passedSet = new Set(verified.filter((id) => !failedSet.has(id)));
    const specStatus = {
      sql: `UPDATE story_specs
            SET status = CASE WHEN spec_id IN (${failed.length > 0 ? failed.map(() => "?").join(",") : "NULL"})
                              THEN 'failed' ELSE 'passed' END
            WHERE story_id = ? AND spec_id IN (${verified.length > 0 ? verified.map(() => "?").join(",") : "NULL"})`,
      args: [...failed, input.cardId, ...verified],
    };
    const frozenVersions = await this.definitionVersions(input.cardId);
    const versions = frozenVersions.scenarios;
    const treeSha = input.verifiedTreeSha ?? "";
    const scenarioRows = treeSha === "" ? [] : verified.map((scenarioId) => ({
      sql: `INSERT INTO verify_scenario_results
              (card_id, scenario_id, round, dod_version, scenario_version, verified_tree_sha, outcome, evidence, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.cardId,
        scenarioId,
        input.round,
        frozenVersions.dodVersion ?? "",
        versions.get(scenarioId) ?? "",
        treeSha,
        failedSet.has(scenarioId) ? "failed" : passedSet.has(scenarioId) ? "passed" : "inconclusive",
        input.evidenceDir ?? null,
        time,
      ],
    }));
    await this.client.batch([
      {
        sql: `INSERT INTO verify_records
                (card_id, round, code_session_id, verify_session_id, verdict,
                 failed_scenarios, evidence_dir, screenshots, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          input.cardId,
          input.round,
          input.codeSessionId,
          input.verifySessionId,
          input.verdict,
          JSON.stringify(failed),
          input.evidenceDir ?? null,
          JSON.stringify(input.screenshots ?? []),
          time,
        ],
      },
      {
        sql: `UPDATE stories SET inner_loop_rounds = MAX(inner_loop_rounds, ?), updated_at = ?
              WHERE id = ?`,
        args: [input.round, time, input.cardId],
      },
      specStatus,
      ...scenarioRows,
      eventStatement(runId, input.cardId, "VERIFY", "verify.verdict", {
        round: input.round,
        verdict: input.verdict,
        failedScenarios: failed,
      }, time),
    ], "write");
  }

  /**
   * Stops the card for a person.
   *
   * `detail` is not a fifth stop reason: the four are closed and the DB
   * enforces them. It is what the one reason cannot say on its own -- which
   * convergence classification ended the loop, which question is unanswered --
   * so a person reading the card can tell "went in circles from round two"
   * from "spent its whole budget".
   */
  async stopForInput(
    cardId: string,
    expectedFrom: StoryState,
    reason: StoryStopReason,
    runId: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    assertStoryTransition(expectedFrom, "NEEDS_INPUT", "system");
    // Collected here rather than by whoever reads the card later: the pieces
    // are spread over four tables and the one moment they are all final is
    // this one. A card that stopped used to offer a single word over a history
    // nobody could see without reading the event log by hand.
    const summary = await this.#collectStopSummary(cardId, reason, detail);
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE stories
              SET state = 'NEEDS_INPUT', phase = NULL, stop_reason = ?, resume_state = ?,
                  stop_summary = ?, updated_at = ?
              WHERE id = ? AND state = ?`,
        args: [reason, expectedFrom, JSON.stringify(summary), time, cardId, expectedFrom],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                     ?, NULL, 'story.stopped', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM stories
                WHERE id = ? AND state = 'NEEDS_INPUT' AND stop_reason = ? AND updated_at = ?
              )`,
        args: [runId, runId, cardId, time, JSON.stringify({ from: expectedFrom, reason, ...detail, summary }),
          cardId, reason, time],
      },
    ], "write");
    if (update?.rowsAffected !== 1) {
      throw new Error(`Story stop lost a race: ${cardId} is no longer ${expectedFrom}`);
    }
  }

  /**
   * What this card's rounds added up to, as of the moment it stops.
   *
   * Everything is read from the last human action onwards, which is the same
   * window the budget uses: a person who answered and let the card run again
   * is owed the story of what happened since, not of what they already saw.
   */
  async #collectStopSummary(
    cardId: string,
    reason: StoryStopReason,
    detail?: Record<string, unknown>,
  ): Promise<StopSummary> {
    const story = (await this.client.execute({
      sql: "SELECT last_human_action_at FROM stories WHERE id = ?",
      args: [cardId],
    })).rows[0];
    const since = Number(story?.last_human_action_at ?? 0);
    const [verifications, events, refusals, spend] = await this.client.batch([
      {
        sql: `SELECT round, failed_scenarios, evidence_dir FROM verify_records
              WHERE card_id = ? AND created_at > ? AND verdict = 'rejected' ORDER BY round`,
        args: [cardId, since],
      },
      {
        sql: `SELECT type, data FROM event_log
              WHERE card_id = ? AND ts > ?
                AND type IN ('merge.verification_failed', 'merge.conflict',
                             'merge.baseline_failing', 'story.dispatch_failed')
              ORDER BY id`,
        args: [cardId, since],
      },
      {
        sql: `SELECT phase, failure FROM phase_runs
              WHERE card_id = ? AND status = 'failed' AND failure IS NOT NULL
                AND COALESCE(ended_at, started_at) > ?
              ORDER BY COALESCE(ended_at, started_at) DESC LIMIT 5`,
        args: [cardId, since],
      },
      {
        sql: `SELECT COALESCE(SUM(CASE WHEN is_subscription = 0 THEN cost_usd ELSE 0 END), 0) AS billed
              FROM cost_entries WHERE card_id = ?`,
        args: [cardId],
      },
    ], "read");

    const rounds = verifications!.rows.map((row) => ({
      round: numberValue(row.round, "round"),
      failed: parseStringArray(row.failed_scenarios, "failed scenarios"),
      reasons: [] as { scenarioId: string; reason: string; detail?: string }[],
    }));
    // The per-scenario reasons live in the verification artifact, which is the
    // only place the words the verifier used survive.
    for (const round of rounds) {
      const artifact = (await this.client.execute({
        sql: `SELECT body FROM phase_artifacts
              WHERE card_id = ? AND phase = 'VERIFY' AND round = ? AND kind = 'verification'
              ORDER BY id DESC LIMIT 1`,
        args: [cardId, round.round],
      })).rows[0];
      if (!artifact) continue;
      round.reasons = scenarioFailuresOf(stringValue(artifact.body, "verification artifact"))
        .map((failure) => ({ scenarioId: failure.scenarioId, reason: failure.reason }));
    }

    const mergeBounces: StopSummaryMergeBounce[] = [];
    const baselineFailures: StopSummaryBaselineFailure[] = [];
    const dispatchFailures: StopSummaryDispatchFailure[] = [];
    for (const row of events!.rows) {
      const data = JSON.parse(stringValue(row.data, "event")) as Record<string, unknown>;
      const failures = Array.isArray(data.failures) ? data.failures.map(String) : [];
      const check = Array.isArray(data.failedChecks) ? String(data.failedChecks[0] ?? "") : String(data.check ?? "");
      if (String(row.type) === "merge.baseline_failing") {
        baselineFailures.push({ check, failures });
      } else if (String(row.type) === "story.dispatch_failed") {
        dispatchFailures.push({
          state: String(data.state ?? ""),
          errorClass: String(data.errorClass ?? ""),
          message: String(data.message ?? ""),
        });
      } else if (data.spent === true) {
        mergeBounces.push({
          attribution: String(row.type) === "merge.conflict" ? "conflict" : "story_regression",
          ...(check ? { check } : {}),
          failures,
        });
      }
    }

    const history = rounds.map((round) => round.failed);
    const diagnosis = diagnosisFor(reason, history);
    const summary: StopSummary = {
      cardId,
      reason,
      spent: numberValue(detail?.spent ?? rounds.length + mergeBounces.length, "rounds spent"),
      budget: numberValue(detail?.budget ?? 0, "round budget"),
      rounds,
      mergeBounces,
      baselineFailures,
      refusals: refusals!.rows
        .map((row) => ({
          phase: stringValue(row.phase, "phase"),
          reason: stringValue(row.failure, "failure").slice(0, 800),
        }))
        .filter((refusal) => !isProviderFault(refusal.reason)),
      dispatchFailures,
      costUsd: Number(spend!.rows[0]?.billed ?? 0),
      ...(diagnosis ? { diagnosis } : {}),
    };
    return typeof detail?.convergence === "string"
      ? { ...summary, convergence: detail.convergence as ConvergenceClassification }
      : summary;
  }

  /**
   * What the card said when it stopped, or null once a person has restarted
   * it: a summary of rounds that are no longer the reason the card is where it
   * is would be read as current.
   */
  async stopSummary(cardId: string): Promise<StopSummary | null> {
    const row = (await this.client.execute({
      sql: "SELECT stop_reason, stop_summary FROM stories WHERE id = ?",
      args: [cardId],
    })).rows[0];
    if (!row || row.stop_reason === null || row.stop_summary === null) return null;
    return JSON.parse(stringValue(row.stop_summary, "stop summary")) as StopSummary;
  }

  /**
   * Counts a failed worker attempt so the dispatcher can bound automatic phase
   * reentries before parking the card for a human, and writes down what died.
   *
   * The count alone used to be the whole record: a card could reach its
   * reentry ceiling and stop with no event, no message and nothing in the
   * phase runs, because the run died before the worker wrote anything. Whoever
   * opened the card then read "retry limit exceeded" over an empty history.
   * The message is redacted on the way in - it is a process's stderr, which is
   * the one place a credential reaches this table.
   */
  async recordDispatchFailure(input: {
    cardId: string;
    state: StoryState;
    errorClass: string;
    message: string;
    attempt: number;
    budget: number;
    runId: string;
  }): Promise<void> {
    await this.guard(input.cardId);
    const time = this.now();
    const data = redactForExport({
      state: input.state,
      errorClass: input.errorClass,
      attempt: input.attempt,
      budget: input.budget,
      message: input.message.slice(0, DISPATCH_FAILURE_MESSAGE_LIMIT),
    });
    await this.client.batch([
      {
        sql: "UPDATE stories SET phase_reentries = phase_reentries + 1, updated_at = ? WHERE id = ?",
        args: [time, input.cardId],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                      ?, ?, 'story.dispatch_failed', ?, ?)`,
        args: [input.runId, input.runId, input.cardId, phaseForState(input.state), time, JSON.stringify(data)],
      },
    ], "write");
  }

  /** Marks a completed phase result as unusable so the next attempt regenerates
   * it; used when a consumer rejects the frozen content (e.g. DoD contract). */
  /** Discarding a completed result is the one mutation that contradicts the
   * frozen-setpoint rule, so it leaves its own audit record. */
  async invalidateCompletedPhase(cardId: string, phase: StoryPhase, round: number, reason: string): Promise<void> {
    const row = (await this.client.execute({
      sql: `SELECT run_id FROM phase_runs
            WHERE card_id = ? AND phase = ? AND round = ? AND status = 'completed'`,
      args: [cardId, phase, round],
    })).rows[0];
    if (!row) return;
    const runId = stringValue(row.run_id, "run id");
    const time = this.now();
    await this.client.batch([
      {
        sql: `UPDATE phase_runs
              SET status = 'failed', failure = ?, ended_at = ?
              WHERE run_id = ? AND status = 'completed'`,
        args: [`invalidated: ${reason}`, time, runId],
      },
      eventStatement(runId, cardId, phase, "phase.invalidated", { round, reason }, time),
    ], "write");
  }

  /**
   * Invalidates the newest completed run of a phase, whatever round it was.
   *
   * A person refusing a result does not know the round it was produced in, and
   * making them name one would be asking them to read the execution's
   * bookkeeping to say "not this".
   */
  async invalidateLatestPhase(cardId: string, phase: StoryPhase, reason: string): Promise<void> {
    const row = (await this.client.execute({
      sql: `SELECT round FROM phase_runs
            WHERE card_id = ? AND phase = ? AND status = 'completed'
            ORDER BY round DESC LIMIT 1`,
      args: [cardId, phase],
    })).rows[0];
    if (!row) return;
    await this.invalidateCompletedPhase(cardId, phase, Number(row.round), reason);
  }

  /**
   * The scenario a reported defect is about: the one the comment was anchored
   * to, or one the text names. A defect that names no scenario opens no card --
   * the regression loop is keyed by scenario, and guessing which one somebody
   * meant would send the fix at the wrong acceptance criterion.
   */
  async defectScenario(cardId: string, specId: string | null, body: string): Promise<string | null> {
    const declared = (await this.client.execute({
      sql: "SELECT spec_id FROM story_specs WHERE story_id = ?",
      args: [cardId],
    })).rows.map((row) => stringValue(row.spec_id, "spec id"));
    if (specId && declared.includes(specId)) return specId;
    return declared.find((id) => body.includes(id)) ?? null;
  }

  /** Opens a regression card by hand, the same object the sweep raises. */
  async openRegressionCard(input: { cardId: string; scenarioId: string; signature: string }): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO regression_cards (scenario_id, failure_signature, attributed_story, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(scenario_id, failure_signature) DO NOTHING`,
      args: [input.scenarioId, input.signature, input.cardId, this.now()],
    });
  }

  /**
   * Marks the SPECIFY a regression card enters as the narrow one.
   *
   * `transition` derives the phase from the state, so a card reopened into
   * SPECIFY would otherwise look like any card on its way to CODE and would
   * write a full test contract instead of one reproduction. The sweep sets the
   * same marker in its own reopen statement.
   */
  async markNarrowSpecify(cardId: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE stories SET phase = 'REGRESSION_FIX', updated_at = ? WHERE id = ? AND state = 'SPECIFY'",
      args: [this.now(), cardId],
    });
  }

  /** One more entry into the regression loop; the ceiling is on entries, the
   * inner rounds inside one entry are bounded separately. */
  async countRegressionReopen(cardId: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE stories SET regression_reopens = regression_reopens + 1, updated_at = ? WHERE id = ?",
      args: [this.now(), cardId],
    });
  }

  /** Closes a regression card once its fix is on the Epic head. False when
   * another path closed it first, which is not an error. */
  async resolveRegressionCard(scenarioId: string, signature: string, storyId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE regression_cards SET resolved_at = ?
             WHERE scenario_id = ? AND failure_signature = ? AND attributed_story = ? AND resolved_at IS NULL`,
      args: [this.now(), scenarioId, signature, storyId],
    });
    return result.rowsAffected === 1;
  }

  /** The Epic head refused a regression fix. The Story stays in REGRESSION_FIX
   * and the reason becomes the next round's task, so nothing moves state. */
  async recordRegressionLandingFailure(cardId: string, runId: string, reason: string): Promise<void> {
    if (reason.trim() === "") throw new Error("landing failure reason must not be empty");
    await this.client.execute(eventStatement(runId, cardId, "REGRESSION_FIX", "merge.verification_failed", { reason }, this.now()));
  }

  /**
   * Prepares a Story to be shaped again. The frozen DoD is the setpoint every
   * later phase reuses, so sending a Story back to SHAPE has to unfreeze it and
   * discard the round-1 results of every phase that read that setpoint, which
   * idempotent re-entry would otherwise hand back unchanged. CODE rounds that
   * never reached a verdict are discarded too: they were written against the
   * old setpoint.
   */
  async resetForRedesign(cardId: string, reason: string): Promise<void> {
    const time = this.now();
    const stale = (await this.client.execute({
      sql: `SELECT run_id, phase, round FROM phase_runs r
             WHERE card_id = ? AND status = 'completed'
               AND (
                 (phase IN ('SHAPE', 'DESIGN', 'SPECIFY', 'MERGE') AND round = 1)
                 OR (phase = 'CODE' AND NOT EXISTS (
                   SELECT 1 FROM verify_records v WHERE v.card_id = r.card_id AND v.round = r.round))
               )`,
      args: [cardId],
    })).rows;
    await this.client.batch([
      ...stale.flatMap((row) => [
        {
          sql: `UPDATE phase_runs SET status = 'failed', failure = ?, ended_at = ?
                WHERE run_id = ? AND status = 'completed'`,
          args: [`invalidated: ${reason}`, time, stringValue(row.run_id, "run id")],
        },
        eventStatement(
          stringValue(row.run_id, "run id"),
          cardId,
          stringValue(row.phase, "phase"),
          "phase.invalidated",
          { round: row.round, reason },
          time,
        ),
      ]),
      { sql: "DELETE FROM story_specs WHERE story_id = ?", args: [cardId] },
      eventStatement(`${cardId}-redesign-${time}`, cardId, "SHAPE", "story.redesign", { reason }, time),
    ], "write");
  }

  /** A rebase conflict remains in the Story worktree for the CODE agent; it is
   * not a delivery and must not be hidden behind an automatic choice. The
   * files travel with it: they are what the next round has to reconcile, and
   * what a count of these conflicts is worth reading by. */
  recordMergeConflict(
    cardId: string,
    runId: string,
    reason: string,
    files: readonly string[] = [],
  ): Promise<void> {
    return this.returnMergeToCode(cardId, runId, "merge.conflict", reason,
      files.length > 0 ? { conflictedFiles: files } : undefined);
  }

  /** Re-verifying the affected scenarios on the Epic head failed. The Story is
   * not wrong on its own branch, but it is wrong beside what merged before it,
   * which is the CODE agent's problem to fix. */
  recordIntegrationRejection(
    cardId: string,
    runId: string,
    reason: string,
    detail?: MergeRejectionDetail,
  ): Promise<void> {
    return this.returnMergeToCode(cardId, runId, "merge.verification_failed", reason, detail);
  }

  /**
   * Sends a refused merge back to CODE through the state machine, and says
   * whether the round costs the Story one of its budget.
   *
   * It used to be a bare UPDATE with no transition event and no accounting, so
   * a Story could bounce between MERGE and CODE forever: S-AGENTRULES-01 did
   * it twice on a failure it had not caused and would have kept going. A
   * failure the Story introduced, and a conflict only it can resolve, spend a
   * round; a head that was already red and a check that never ran do not, since
   * no amount of work on this card changes either.
   */
  private async returnMergeToCode(
    cardId: string,
    runId: string,
    type: string,
    reason: string,
    detail?: MergeRejectionDetail,
  ): Promise<void> {
    if (reason.trim() === "") throw new Error("merge rejection reason must not be empty");
    const spent = detail?.attribution !== "baseline_failing" && detail?.attribution !== "environment";
    const time = this.now();
    const [update] = await this.client.batch([
      storyTransitionStatement({ cardId, from: "MERGE", to: "CODE", at: time, set: { phase: "CODE" } }),
      eventStatement(runId, cardId, "MERGE", type, { reason, ...detail, spent }, time),
      eventStatement(runId, cardId, "CODE", "story.transition", { from: "MERGE", to: "CODE", actor: "system" }, time),
    ], "write");
    if (update?.rowsAffected !== 1) throw new Error(`cannot return ${cardId} to CODE unless it is in MERGE`);
  }

  /**
   * The same check fails on the Epic head without this Story.
   *
   * The Story stays in MERGE: it is not wrong, and sending it back to CODE
   * would buy model turns to fix something that is not on its branch. The
   * failure is recorded against the Epic instead, which is what blocks the
   * Epic and what a recheck clears once the head is green again.
   */
  async recordBaselineFailure(input: {
    cardId: string;
    runId: string;
    check: string;
    failures: readonly string[];
    headSha: string;
    reason: string;
  }): Promise<void> {
    const row = (await this.client.execute({
      sql: "SELECT epic_id FROM stories WHERE id = ?",
      args: [input.cardId],
    })).rows[0];
    const epicId = String(row?.epic_id ?? "");
    if (!epicId) throw new Error(`Story ${input.cardId} belongs to no Epic`);
    const time = this.now();
    const epicRunId = `epic:${epicId}`;
    const detail = { check: input.check, failures: input.failures, headSha: input.headSha };
    await this.client.batch([
      eventStatement(input.runId, input.cardId, "MERGE", "merge.baseline_failing", { reason: input.reason, ...detail, spent: false }, time),
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                      NULL, NULL, 'epic.head_failing', ?, ?)`,
        args: [epicRunId, epicRunId, time, JSON.stringify({ storyId: input.cardId, ...detail })],
      },
    ], "write");
  }

  /**
   * Rounds this Story has spent since a person last acted on it.
   *
   * CODE, VERIFY and MERGE are one loop, so a merge the Story's own work broke
   * costs the same as a verification round it failed. The count comes from
   * events rather than a column because the two sources already exist and a
   * column would have to repeat the "since the last human action" rule that
   * grants a resumed card a fresh budget. verify_records cannot hold the merge
   * bounces either: it is keyed by round and requires the two session ids a
   * bounce does not have.
   */
  async getInnerLoopSpend(cardId: string, since = 0): Promise<number> {
    const [verifications, bounces] = await this.client.batch([
      {
        sql: `SELECT COUNT(*) AS spent FROM verify_records
              WHERE card_id = ? AND created_at > ? AND verdict = 'rejected'`,
        args: [cardId, since],
      },
      {
        sql: `SELECT COUNT(*) AS spent FROM event_log
              WHERE card_id = ? AND ts > ?
                AND type IN ('merge.verification_failed', 'merge.conflict')
                AND json_extract(data, '$.spent') = 1`,
        args: [cardId, since],
      },
    ], "read");
    return numberValue(verifications!.rows[0]!.spent, "verification rounds")
      + numberValue(bounces!.rows[0]!.spent, "merge bounces");
  }

  /** The Story is on the Epic head. Recorded so a later Story's subset
   * re-verification knows what it has to hold beside, and so the branch the
   * Epic lives on is durable rather than inferred from a naming rule. */
  async markIntegrated(cardId: string, integrationBranch: string): Promise<void> {
    const time = this.now();
    await this.client.batch([
      {
        sql: `UPDATE execution_dispatches SET state = 'integrated', integrated_at = ?
              WHERE story_id = ?`,
        args: [time, cardId],
      },
      {
        sql: `UPDATE epics SET integration_branch = ?, updated_at = ?
              WHERE id = (SELECT epic_id FROM stories WHERE id = ?) AND integration_branch IS NULL`,
        args: [integrationBranch, time, cardId],
      },
      {
        // A new head invalidates what was verified against the old one, which
        // is what makes a merge trigger the Epic's next regression sweep.
        sql: `UPDATE scenario_registry SET last_verified_at = NULL, updated_at = ?
               WHERE epic_id = (SELECT epic_id FROM stories WHERE id = ?)`,
        args: [time, cardId],
      },
    ], "write");
  }

  /** Stories already on this Epic's head, with the scenarios each one owns. */
  async integratedStories(epicId: string): Promise<Array<{ id: string; branch: string; predictedFootprint: string[]; scenarioIds: string[] }>> {
    const rows = (await this.client.execute({
      sql: `SELECT s.id, s.branch, s.predicted_footprint
              FROM execution_dispatches d JOIN stories s ON s.id = d.story_id
             WHERE d.epic_id = ? AND d.state = 'integrated'
             ORDER BY d.integrated_at, s.id`,
      args: [epicId],
    })).rows;
    const stories = [];
    for (const row of rows) {
      const specs = (await this.client.execute({
        sql: "SELECT spec_id FROM story_specs WHERE story_id = ? ORDER BY seq",
        args: [String(row.id)],
      })).rows.map((spec) => stringValue(spec.spec_id, "spec id"));
      stories.push({
        id: String(row.id),
        branch: String(row.branch ?? ""),
        predictedFootprint: parseStringArray(row.predicted_footprint, "predicted footprint"),
        scenarioIds: specs,
      });
    }
    return stories;
  }

  async markDelivered(cardId: string, runId: string, mrUrl: string | null): Promise<void> {
    if (mrUrl !== null && !mrUrl.startsWith("https://")) throw new Error("MR URL must use HTTPS");
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE stories
              SET state = 'DELIVERED', phase = NULL, mr_url = ?, stop_reason = NULL,
                  resume_state = NULL, updated_at = ?
              WHERE id = ? AND state = 'MERGE'`,
        args: [mrUrl, time, cardId],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                     ?, 'MERGE', 'story.delivered', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM stories
                WHERE id = ? AND state = 'DELIVERED' AND mr_url IS ? AND updated_at = ?
              )`,
        args: [runId, runId, cardId, time, JSON.stringify({ mrUrl }), cardId, mrUrl, time],
      },
    ], "write");
    if (update?.rowsAffected !== 1) throw new Error(`cannot deliver Story ${cardId} unless it is in MERGE`);
  }

  async registerNotionSection(
    cardId: string,
    section: StorySection,
    anchorBlockId: string,
  ): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO notion_sections (story_id, section, anchor_block_id)
            VALUES (?, ?, ?)
            ON CONFLICT(story_id, section) DO UPDATE SET anchor_block_id = excluded.anchor_block_id`,
      args: [cardId, section, anchorBlockId],
    });
  }

  async freezeDefinitionOfDone(cardId: string, definition: DefinitionOfDone): Promise<void> {
    if (definition.story_id !== cardId) {
      throw new Error(`DoD story id ${definition.story_id} does not match ${cardId}`);
    }
    const existing = await this.client.execute({
      sql: "SELECT COUNT(*) AS count FROM story_specs WHERE story_id = ?",
      args: [cardId],
    });
    if (Number(existing.rows[0]?.count) > 0) throw new Error(`Story DoD is already frozen: ${cardId}`);
    const statements = definition.scenarios.map((scenario, index) => ({
      sql: `INSERT INTO story_specs (spec_id, story_id, seq, text, title, given, when_, then_, layers, visible_json, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      args: [
        scenario.id,
        cardId,
        index + 1,
        `Given ${scenario.given}; when ${scenario.when}; then ${scenario.then}`,
        scenario.title ?? null,
        scenario.given,
        scenario.when,
        scenario.then,
        JSON.stringify(scenario.layers),
        scenario.visible ? JSON.stringify(scenario.visible) : null,
      ],
    }));
    const time = this.now();
    const cardVersion = dodVersion(definition);
    const perScenario = scenarioVersions(definition);
    await this.client.batch([
      ...statements,
      ...Object.entries(perScenario).map(([scenarioId, version]) => ({
        sql: `INSERT INTO story_dod_versions (card_id, dod_version, scenario_id, scenario_version, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(card_id, scenario_id) DO UPDATE SET
                dod_version = excluded.dod_version,
                scenario_version = excluded.scenario_version,
                created_at = excluded.created_at`,
        args: [cardId, cardVersion, scenarioId, version, time],
      })),
      {
        sql: `UPDATE stories SET predicted_footprint = ?, depends_on = ?, updated_at = ?
              WHERE id = ?`,
        args: [
          JSON.stringify([...definition.predicted_footprint].toSorted()),
          JSON.stringify([...definition.depends_on].toSorted()),
          this.now(),
          cardId,
        ],
      },
    ], "write");
  }

  // --- per-scenario conclusions ---

  /** The latest conclusion recorded for each scenario. */
  async scenarioConclusions(cardId: string): Promise<Map<string, ScenarioConclusion & { id: number }>> {
    const rows = (await this.client.execute({
      sql: `SELECT id, scenario_id, round, outcome, scenario_version, verified_tree_sha, carried_from
            FROM verify_scenario_results WHERE card_id = ? ORDER BY id`,
      args: [cardId],
    })).rows;
    const latest = new Map<string, ScenarioConclusion & { id: number }>();
    for (const row of rows) {
      latest.set(String(row.scenario_id), {
        id: Number(row.id),
        scenarioId: String(row.scenario_id),
        round: Number(row.round),
        outcome: String(row.outcome) as ScenarioConclusion["outcome"],
        scenarioVersion: String(row.scenario_version),
        verifiedTreeSha: String(row.verified_tree_sha),
        ...(row.carried_from === null ? {} : { carriedFrom: Number(row.carried_from) }),
      });
    }
    return latest;
  }

  /**
   * Carries an untouched scenario's conclusion onto the current contract and
   * tree, as a new row pointing at the original.
   *
   * Both conditions must hold. An unchanged contract does not prove the
   * conclusion still stands: the fix that another scenario needed may have
   * changed code the two of them share. When the tree has moved, nothing is
   * carried and the card re-verifies in full -- no dependency analysis, which
   * is simply today's behaviour and an acceptable price.
   */
  async carryForwardScenarios(input: {
    cardId: string;
    round: number;
    treeSha: string;
  }): Promise<{ carried: string[]; stale: string[] }> {
    const time = this.now();
    const { dodVersion: cardVersion, scenarios: versions } = await this.definitionVersions(input.cardId);
    const latest = await this.scenarioConclusions(input.cardId);
    const carried: string[] = [];
    const stale: string[] = [];
    const statements = [];
    for (const [scenarioId, version] of versions) {
      const previous = latest.get(scenarioId);
      if (!previous || previous.outcome !== "passed") continue;
      // This round judged it itself; carrying it forward as well would write a
      // second conclusion for the same scenario in the same round.
      if (previous.round === input.round) continue;
      if (previous.scenarioVersion !== version || previous.verifiedTreeSha !== input.treeSha) {
        stale.push(scenarioId);
        continue;
      }
      carried.push(scenarioId);
      statements.push({
        sql: `INSERT INTO verify_scenario_results
                (card_id, scenario_id, round, dod_version, scenario_version, verified_tree_sha,
                 outcome, evidence, carried_from, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'passed', NULL, ?, ?)`,
        args: [input.cardId, scenarioId, input.round, cardVersion ?? "", version, input.treeSha, previous.id, time],
      });
    }
    if (statements.length > 0) await this.client.batch(statements, "write");
    return { carried: carried.toSorted(), stale: stale.toSorted() };
  }

  /**
   * Whether every declared scenario has a passing conclusion at its current
   * contract version and on the tree about to be merged. This is the system
   * precondition on the VERIFY -> MERGE edge.
   */
  async scenariosSettled(cardId: string, treeSha: string): Promise<{ ready: boolean; outstanding: string[] }> {
    const { scenarios: versions } = await this.definitionVersions(cardId);
    const latest = await this.scenarioConclusions(cardId);
    const outstanding: string[] = [];
    for (const [scenarioId, version] of versions) {
      const conclusion = latest.get(scenarioId);
      if (!conclusion || conclusion.outcome !== "passed"
        || conclusion.scenarioVersion !== version
        || conclusion.verifiedTreeSha !== treeSha) {
        outstanding.push(scenarioId);
      }
    }
    return { ready: outstanding.length === 0, outstanding: outstanding.toSorted() };
  }

  // --- the frozen acceptance contract's versions ---

  /** The card's contract hash and each scenario's own, as frozen. */
  async definitionVersions(cardId: string): Promise<{ dodVersion: string | null; scenarios: Map<string, string> }> {
    const rows = (await this.client.execute({
      sql: "SELECT dod_version, scenario_id, scenario_version FROM story_dod_versions WHERE card_id = ?",
      args: [cardId],
    })).rows;
    return {
      dodVersion: rows[0] ? String(rows[0].dod_version) : null,
      scenarios: new Map(rows.map((row) => [String(row.scenario_id), String(row.scenario_version)])),
    };
  }

  /**
   * Replaces the frozen contract after a person answered a question.
   *
   * Scenarios whose own hash did not move keep their conclusions; the ones that
   * moved lose theirs. Judging this on the card-level hash instead would void
   * every scenario whenever any one of them was reworded, which is the same as
   * tearing the card down and rebuilding it.
   */
  async refreezeDefinitionOfDone(cardId: string, definition: DefinitionOfDone): Promise<{ changed: string[] }> {
    const before = await this.definitionVersions(cardId);
    const after = scenarioVersions(definition);
    const changed = Object.keys(after)
      .filter((id) => before.scenarios.get(id) !== after[id])
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    await this.client.execute({ sql: "DELETE FROM story_specs WHERE story_id = ?", args: [cardId] });
    await this.client.execute({ sql: "DELETE FROM story_dod_versions WHERE card_id = ?", args: [cardId] });
    await this.freezeDefinitionOfDone(cardId, definition);
    return { changed };
  }

  // --- questions SHAPE raised ---

  async recordOpenQuestions(
    cardId: string,
    questions: ReadonlyArray<{ id: string; question: string; suggestion: string; blocking: boolean }>,
  ): Promise<void> {
    if (questions.length === 0) return;
    const time = this.now();
    await this.client.batch(questions.map((item) => ({
      // A question already on the card keeps its answer: a rerun of SHAPE asks
      // the same things again, and re-asking what somebody answered is how a
      // card ends up waiting forever.
      sql: `INSERT INTO open_questions (card_id, question_key, question, suggestion, blocking, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(card_id, question_key) DO UPDATE SET
              question = excluded.question,
              suggestion = excluded.suggestion,
              blocking = excluded.blocking`,
      args: [cardId, item.id, item.question, item.suggestion, item.blocking ? 1 : 0, time],
    })), "write");
  }

  async openQuestions(cardId: string): Promise<Array<{
    key: string; question: string; suggestion: string; blocking: boolean; answer: string | null;
  }>> {
    const rows = (await this.client.execute({
      sql: `SELECT question_key, question, suggestion, blocking, answer
            FROM open_questions WHERE card_id = ? ORDER BY id`,
      args: [cardId],
    })).rows;
    return rows.map((row) => ({
      key: String(row.question_key),
      question: String(row.question),
      suggestion: String(row.suggestion),
      blocking: Number(row.blocking) === 1,
      answer: row.answer === null ? null : String(row.answer),
    }));
  }

  /** Questions that hold the card up: blocking and still unanswered. */
  async unansweredBlockingQuestions(cardId: string): Promise<string[]> {
    return (await this.openQuestions(cardId))
      .filter((item) => item.blocking && item.answer === null)
      .map((item) => item.question);
  }

  async answerOpenQuestion(cardId: string, key: string, answer: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "UPDATE open_questions SET answer = ?, answered_at = ? WHERE card_id = ? AND question_key = ?",
      args: [answer, this.now(), cardId, key],
    });
    return result.rowsAffected > 0;
  }

  // --- what SPECIFY froze ---

  /** Opens an attempt and pins the baseline its tree-pin will clean against. */
  async beginTestContract(input: {
    cardId: string; attempt: number; mode: "full" | "narrow"; contractYaml: string;
    specifyBaseCommit: string; testPaths: readonly string[];
  }): Promise<void> {
    await this.guard(input.cardId);
    await this.client.execute({
      sql: `INSERT INTO story_test_contracts
              (card_id, attempt, mode, contract_yaml, specify_base_commit, test_paths, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(card_id, attempt) DO UPDATE SET
              mode = excluded.mode,
              contract_yaml = excluded.contract_yaml,
              specify_base_commit = excluded.specify_base_commit,
              test_paths = excluded.test_paths`,
      args: [input.cardId, input.attempt, input.mode, input.contractYaml, input.specifyBaseCommit,
             JSON.stringify([...input.testPaths].toSorted()), this.now()],
    });
  }

  async freezeTestContract(cardId: string, attempt: number, commit: string, treeSha: string): Promise<void> {
    await this.guard(cardId);
    await this.client.execute({
      sql: `UPDATE story_test_contracts SET specify_commit = ?, specify_tree_sha = ?, frozen_at = ?
            WHERE card_id = ? AND attempt = ?`,
      args: [commit, treeSha, this.now(), cardId, attempt],
    });
  }

  /** The most recent frozen contract, which is the baseline CODE is fenced and
   * measured against. */
  async frozenTestContract(cardId: string): Promise<{
    attempt: number; mode: "full" | "narrow"; contractYaml: string;
    specifyBaseCommit: string; specifyCommit: string; testPaths: string[];
  } | null> {
    const row = (await this.client.execute({
      sql: `SELECT attempt, mode, contract_yaml, specify_base_commit, specify_commit, test_paths
            FROM story_test_contracts
            WHERE card_id = ? AND specify_commit IS NOT NULL
            ORDER BY attempt DESC LIMIT 1`,
      args: [cardId],
    })).rows[0];
    if (!row) return null;
    return {
      attempt: Number(row.attempt),
      mode: String(row.mode) as "full" | "narrow",
      contractYaml: String(row.contract_yaml),
      specifyBaseCommit: String(row.specify_base_commit),
      specifyCommit: String(row.specify_commit),
      testPaths: JSON.parse(String(row.test_paths)) as string[],
    };
  }

  /** How many attempts the card has opened, so the next one gets a new number. */
  async testContractAttempts(cardId: string): Promise<number> {
    const row = (await this.client.execute({
      sql: "SELECT COALESCE(MAX(attempt), 0) AS attempts FROM story_test_contracts WHERE card_id = ?",
      args: [cardId],
    })).rows[0];
    return Number(row?.attempts ?? 0);
  }

  async buildPhaseInput(cardId: string, phase: StoryPhase, round: number): Promise<PhaseInput> {
    const story = await this.getStory(cardId);
    // A rejection an already-completed CODE round has answered is history, not
    // a task: only what was refused since CODE last finished is still open.
    const writingPhase = phase === "REGRESSION_FIX" ? "REGRESSION_FIX" : "CODE";
    const lastCodeEnd = Number((await this.client.execute({
      sql: `SELECT COALESCE(MAX(ended_at), 0) AS at FROM phase_runs
            WHERE card_id = ? AND phase = ? AND status = 'completed'`,
      args: [cardId, writingPhase],
    })).rows[0]?.at ?? 0);
    const [specResult, artifactResult, feedbackResult, verifyResult, rejectionResult, bounceResult, invalidationResult] = await Promise.all([
      this.client.execute({
        sql: "SELECT spec_id, status, text FROM story_specs WHERE story_id = ? ORDER BY spec_id",
        args: [cardId],
      }),
      // Only the newest artifact of each kind: every earlier one is a superseded
      // account of the same thing, and six of them buried the one line a
      // person wrote under 18KB the model had to read first.
      this.client.execute({
        sql: `SELECT a.phase, a.kind, a.body FROM phase_artifacts a
              WHERE a.card_id = ?
                AND a.id = (SELECT MAX(b.id) FROM phase_artifacts b
                            WHERE b.card_id = a.card_id AND b.phase = a.phase AND b.kind = a.kind)
              ORDER BY a.phase, a.kind`,
        args: [cardId],
      }),
      this.client.execute({
        // Answers and added material both reach the round, and they reach it
        // differently: an answer is a decision the round owes a reply to, and
        // material somebody added is not. Rework and defect never arrive here
        // at all -- they moved the card instead.
        sql: `SELECT hf.comment_id, COALESCE(ic.author, 'unknown') AS author, hf.spec_id, hf.body, hf.channel
              FROM human_feedback hf
              LEFT JOIN ingested_comments ic ON ic.comment_id = hf.comment_id
              WHERE hf.card_id = ? AND hf.channel IN ('answer', 'preference', 'unclassified')
              ORDER BY hf.comment_id`,
        args: [cardId],
      }),
      this.client.execute({
        sql: `SELECT round, failed_scenarios, evidence_dir FROM verify_records
              WHERE card_id = ? ORDER BY round`,
        args: [cardId],
      }),
      this.client.execute({
        // This phase's own rejections, plus MERGE's for CODE: the merge gate
        // cannot change code, so what it refused is CODE's to fix next round.
        // run_id breaks the tie two rows written in the same millisecond would
        // otherwise leave to SQLite.
        sql: `SELECT phase, failure FROM phase_runs
              WHERE card_id = ? AND phase IN (?, ?) AND status = 'failed' AND failure IS NOT NULL
                AND COALESCE(ended_at, started_at) > ?
              ORDER BY ended_at DESC, started_at DESC, run_id DESC LIMIT 5`,
        args: [cardId, phase, phase === "CODE" ? "MERGE" : phase, lastCodeEnd],
      }),
      // The Epic head bouncing the branch (a rebase conflict, a failed subset
      // re-verification) is recorded as an event, not a phase run; it is the
      // most recent reason a CODE round exists at all.
      this.client.execute({
        sql: `SELECT type, data FROM event_log
              WHERE card_id = ? AND type IN ('merge.verification_failed', 'merge.conflict') AND ts > ?
              ORDER BY id DESC LIMIT ?`,
        args: [cardId, lastCodeEnd, phase === writingPhase ? 2 : 0],
      }),
      // A completed result the consumer threw away (a DoD the contract
      // refused) is superseded in phase_runs by the next attempt, so the
      // reason only survives here. The next attempt has to read it, or it
      // repeats the same mistake with no idea it made one.
      this.client.execute({
        sql: `SELECT data FROM event_log
              WHERE card_id = ? AND phase = ? AND type = 'phase.invalidated' AND ts > ?
              ORDER BY id DESC LIMIT 2`,
        args: [cardId, phase, lastCodeEnd],
      }),
    ]);

    // A REGRESSION_FIX round exists for the open regression cards, not for the
    // last verdict (which accepted everything, or the Story was never
    // delivered). The narrow SPECIFY in front of it reads the same cards: it is
    // asked for one reproduction per open signature, and without them its
    // prompt would be indistinguishable from a full pass while its exit still
    // required `mode: narrow`. Every other phase leaves this table alone, so
    // their prompts stay byte-identical whether or not cards exist.
    const readsRegressionCards = phase === "REGRESSION_FIX"
      || (phase === "SPECIFY" && story.phase === "REGRESSION_FIX");
    const regressions = readsRegressionCards
      ? (await this.client.execute({
          sql: `SELECT scenario_id, failure_signature, failure_text, attributed_story FROM regression_cards
                 WHERE attributed_story = ? AND resolved_at IS NULL ORDER BY created_at, scenario_id`,
          args: [cardId],
        })).rows.map((row) => {
          const card: RegressionCardRef = {
            scenarioId: stringValue(row.scenario_id, "regression scenario"),
            signature: stringValue(row.failure_signature, "regression signature"),
            attributedStory: stringValue(row.attributed_story, "attributed story"),
          };
          if (row.failure_text !== null && row.failure_text !== undefined) {
            card.failureText = String(row.failure_text);
          }
          return card;
        })
      : null;
    const latestVerify = verifyResult.rows.at(-1);
    const failedScenarios = regressions
      ? [...new Set(regressions.map((card) => card.scenarioId))].toSorted()
      : latestVerify
        ? parseStringArray(latestVerify.failed_scenarios, "failed scenarios")
        : [];
    const evidenceDir = latestVerify ? optionalString(latestVerify.evidence_dir) : null;
    const verification = artifactResult.rows.find((row) => row.phase === "VERIFY" && row.kind === "verification");
    const scenarioFailures = verification ? scenarioFailuresOf(stringValue(verification.body, "verification artifact")) : [];

    return {
      cardId,
      phase,
      round,
      title: story.title,
      requirement: story.requirement,
      ...(story.repo ? { repo: story.repo } : {}),
      ...(story.branch ? { branch: story.branch } : {}),
      specs: specResult.rows.map((row) => ({
        id: stringValue(row.spec_id, "spec id"),
        status: stringValue(row.status, "spec status"),
        text: stringValue(row.text, "spec text"),
      })),
      artifacts: artifactResult.rows.map((row) => ({
        phase: stringValue(row.phase, "artifact phase"),
        kind: stringValue(row.kind, "artifact kind"),
        body: stringValue(row.body, "artifact body"),
      })),
      feedback: feedbackResult.rows
        .filter((row) => stringValue(row.channel, "feedback channel") === "answer")
        .map((row) => {
          const item: PhaseInput["feedback"][number] = {
            id: stringValue(row.comment_id, "feedback id"),
            author: stringValue(row.author, "feedback author"),
            body: stringValue(row.body, "feedback body"),
          };
          const specId = optionalString(row.spec_id);
          if (specId) item.specId = specId;
          return item;
        }),
      supplementaryContext: feedbackResult.rows
        .filter((row) => stringValue(row.channel, "feedback channel") !== "answer")
        .map((row) => ({
          id: stringValue(row.comment_id, "feedback id"),
          author: stringValue(row.author, "feedback author"),
          body: stringValue(row.body, "feedback body"),
        })),
      evidence: evidenceDir
        ? failedScenarios.map((scenarioId) => ({ scenarioId, path: evidenceDir }))
        : [],
      failedScenarios,
      scenarioFailures,
      ...(regressions ? { regressions } : {}),
      previousRejections: [
        ...invalidationResult.rows.map((row) => ({
          phase,
          reason: String((JSON.parse(stringValue(row.data, "invalidation event")) as { reason?: string }).reason ?? "").slice(0, 800),
        })).filter((rejection) => rejection.reason !== ""),
        ...rejectionResult.rows
          .map((row) => ({
            phase: stringValue(row.phase, "rejected phase"),
            reason: stringValue(row.failure, "rejection reason").slice(0, 800),
          }))
          // A round the provider killed was not refused for its approach.
          .filter((rejection) => !isProviderFault(rejection.reason)),
        ...bounceResult.rows.map((row) => {
          const event = JSON.parse(stringValue(row.data, "merge event")) as {
            reason?: string;
            failures?: string[];
            conflictedFiles?: string[];
          };
          const headline = String(row.type) === "merge.conflict"
            ? "rebase onto the Epic head conflicted"
            : "the checks failed with this Story on top of the Epic head";
          // Truncation is on the prose only: the names are what the round has
          // to act on, and they used to fall outside the window.
          const rejection: PhaseRejection = {
            phase: "MERGE",
            reason: `${headline}: ${String(event.reason ?? "")}`.slice(0, 800),
          };
          // For a conflict the paths are the names: a round handed git's prose
          // alone has to guess which files the two Stories both touched.
          const named = event.failures ?? event.conflictedFiles;
          if (named && named.length > 0) rejection.failures = named;
          return rejection;
        }),
      ],
    };
  }
}

/**
 * Why each scenario was refused, from both lanes of the verification artifact:
 * the tests' reasons and what the person looking at the screen wrote. The
 * failed set alone told CODE what to fix; this tells it what was wrong.
 */
function scenarioFailuresOf(body: string): ScenarioFailure[] {
  let parsed: {
    reasons?: Array<{ scenarioId?: unknown; reason?: unknown }>;
    uiReview?: { acceptance?: Array<{ id?: unknown; status?: unknown; reason?: unknown; cites?: unknown }> };
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    // An artifact that is not JSON came from a verifier that never reached a
    // verdict; it has no per-scenario reasons to offer.
    return [];
  }
  const failures: ScenarioFailure[] = [];
  for (const item of parsed.reasons ?? []) {
    if (typeof item.scenarioId === "string" && typeof item.reason === "string") {
      failures.push({ scenarioId: item.scenarioId, reason: item.reason, source: "tests" });
    }
  }
  for (const entry of parsed.uiReview?.acceptance ?? []) {
    if (entry.status !== "failed" || typeof entry.id !== "string" || typeof entry.reason !== "string") continue;
    const cites = typeof entry.cites === "string" ? ` (the DoD says: ${entry.cites})` : "";
    failures.push({ scenarioId: entry.id, reason: `${entry.reason}${cites}`, source: "screen" });
  }
  return failures;
}

function phaseForState(state: StoryState): StoryPhase | null {
  switch (state) {
    case "SHAPE":
    case "DESIGN":
    case "SPECIFY":
    case "CODE":
    case "VERIFY":
    case "MERGE":
    case "REGRESSION_FIX":
      return state;
    default:
      return null;
  }
}

function parseStringArray(value: unknown, label: string): string[] {
  if (typeof value !== "string") throw new Error(`${label} is not JSON text`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${label} is not an array of strings`);
  }
  return parsed;
}
