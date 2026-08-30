import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import {
  assertStoryTransition,
  type StoryState,
  type TransitionActor,
} from "./state-machine.js";
import type { Phase, PhaseInput } from "../pipeline/phase-input.js";
import { parseDoD, type DefinitionOfDone } from "../pipeline/dod.js";

export type StoryPhase = Exclude<Phase, "DECOMPOSE">;

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

export interface VerificationRecordInput {
  cardId: string;
  round: number;
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
export class StoryExecutionStore {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

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
                   inner_loop_rounds, phase_reentries, stop_reason
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
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE stories
              SET state = ?, phase = ?, stop_reason = NULL, resume_state = NULL, updated_at = ?
              WHERE id = ? AND state = ?`,
        args: [to, phaseForState(to), time, cardId, expectedFrom],
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
    const [update] = await this.client.batch([
      {
        sql: `UPDATE stories
              SET state = ?, phase = ?, stop_reason = NULL, resume_state = ?,
                  notion_ai_status_shadow = ?, human_wins_until = ?,
                  last_human_action_at = ?, updated_at = ?
              WHERE id = ? AND state = ?`,
        args: [
          input.to,
          phaseForState(input.to),
          resumeState,
          input.observedAiStatus,
          input.humanWinsUntil,
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

  async beginPhase(input: BeginPhaseInput): Promise<void> {
    if (input.round < 1 || !Number.isInteger(input.round)) throw new Error("phase round must be a positive integer");
    const story = await this.getStory(input.cardId);
    if (story.state !== input.phase) {
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
        args: [input.cardId, input.phase, input.round, input.phase],
      },
      {
        sql: `INSERT INTO phase_runs
                (run_id, card_id, phase, round, prompt_sha256, status, started_at)
              SELECT ?, id, ?, ?, ?, 'running', ? FROM stories
              WHERE id = ? AND state = ?
                AND NOT EXISTS (
                  SELECT 1 FROM phase_runs WHERE card_id = id AND phase = ? AND round = ?
                )`,
        args: [input.runId, input.phase, input.round, promptSha256, time, input.cardId, input.phase,
          input.phase, input.round],
      },
      eventStatement(input.runId, input.cardId, input.phase, "phase.enter", {
        round: input.round,
        promptSha256,
      }, time),
    ], "write");
    const inserted = Number(results[1]?.rowsAffected ?? 0);
    if (inserted !== 1) {
      throw new Error(`cannot start ${input.phase} while Story is not in that phase`);
    }
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

  async getVerificationFailureHistory(cardId: string): Promise<string[][]> {
    const rows = (await this.client.execute({
      sql: "SELECT failed_scenarios FROM verify_records WHERE card_id = ? ORDER BY round",
      args: [cardId],
    })).rows;
    return rows.map((row) => parseStringArray(row.failed_scenarios, "failed scenarios"));
  }

  async getDefinitionOfDone(cardId: string): Promise<DefinitionOfDone> {
    const row = (await this.client.execute({
      sql: `SELECT body FROM phase_artifacts
            WHERE card_id = ? AND phase = 'DESIGN' AND kind = 'dod'
            ORDER BY round DESC, id DESC LIMIT 1`,
      args: [cardId],
    })).rows[0];
    if (!row) throw new Error(`Story has no persisted Definition of Done: ${cardId}`);
    return parseDoD(stringValue(row.body, "Definition of Done"));
  }

  /** The frozen setpoint, or null when DESIGN has not produced one yet. */
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
    const specStatus = failed.length === 0
      ? {
          sql: "UPDATE story_specs SET status = 'passed' WHERE story_id = ?",
          args: [input.cardId],
        }
      : {
          sql: `UPDATE story_specs
                SET status = CASE WHEN spec_id IN (${failed.map(() => "?").join(",")})
                                  THEN 'failed' ELSE 'passed' END
                WHERE story_id = ?`,
          args: [...failed, input.cardId],
        };
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
      eventStatement(runId, input.cardId, "VERIFY", "verify.verdict", {
        round: input.round,
        verdict: input.verdict,
        failedScenarios: failed,
      }, time),
    ], "write");
  }

  async stopForInput(
    cardId: string,
    expectedFrom: StoryState,
    reason: "blocking_question" | "verify_loop_exceeded" | "retry_limit_exceeded",
    runId: string,
  ): Promise<void> {
    assertStoryTransition(expectedFrom, "NEEDS_INPUT", "system");
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE stories
              SET state = 'NEEDS_INPUT', phase = NULL, stop_reason = ?, resume_state = ?, updated_at = ?
              WHERE id = ? AND state = ?`,
        args: [reason, expectedFrom, time, cardId, expectedFrom],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                     ?, NULL, 'story.stopped', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM stories
                WHERE id = ? AND state = 'NEEDS_INPUT' AND stop_reason = ? AND updated_at = ?
              )`,
        args: [runId, runId, cardId, time, JSON.stringify({ from: expectedFrom, reason }),
          cardId, reason, time],
      },
    ], "write");
    if (update?.rowsAffected !== 1) {
      throw new Error(`Story stop lost a race: ${cardId} is no longer ${expectedFrom}`);
    }
  }

  /** Counts a failed worker attempt so the dispatcher can bound automatic
   * phase reentries before parking the card for a human. */
  async recordPhaseReentry(cardId: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE stories SET phase_reentries = phase_reentries + 1, updated_at = ? WHERE id = ?",
      args: [this.now(), cardId],
    });
  }

  /** Marks a completed phase result as unusable so the next attempt regenerates
   * it; used when a consumer rejects the frozen content (e.g. DoD contract). */
  async invalidateCompletedPhase(cardId: string, phase: StoryPhase, round: number, reason: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE phase_runs
            SET status = 'failed', failure = ?, ended_at = ?
            WHERE card_id = ? AND phase = ? AND round = ? AND status = 'completed'`,
      args: [`invalidated: ${reason}`, this.now(), cardId, phase, round],
    });
  }

  /** A rebase conflict remains in the Story worktree for the CODE agent; it is
   * not a delivery and must not be hidden behind an automatic choice. */
  async recordMergeConflict(cardId: string, runId: string, reason: string): Promise<void> {
    if (reason.trim() === "") throw new Error("merge conflict reason must not be empty");
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE stories SET state = 'CODE', phase = 'CODE', updated_at = ?
              WHERE id = ? AND state = 'MERGE'`,
        args: [time, cardId],
      },
      eventStatement(runId, cardId, "MERGE", "merge.conflict", { reason }, time),
    ], "write");
    if (update?.rowsAffected !== 1) throw new Error(`cannot record merge conflict unless Story is in MERGE: ${cardId}`);
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
    section: "requirement" | "specification" | "design" | "verification" | "questions",
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
      sql: `INSERT INTO story_specs (spec_id, story_id, seq, text, status)
            VALUES (?, ?, ?, ?, 'pending')`,
      args: [
        scenario.id,
        cardId,
        index + 1,
        `Given ${scenario.given}; when ${scenario.when}; then ${scenario.then}`,
      ],
    }));
    await this.client.batch([
      ...statements,
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

  async buildPhaseInput(cardId: string, phase: StoryPhase, round: number): Promise<PhaseInput> {
    const story = await this.getStory(cardId);
    const [specResult, artifactResult, feedbackResult, verifyResult, rejectionResult] = await Promise.all([
      this.client.execute({
        sql: "SELECT spec_id, status, text FROM story_specs WHERE story_id = ? ORDER BY spec_id",
        args: [cardId],
      }),
      this.client.execute({
        sql: `SELECT phase, kind, body FROM phase_artifacts
              WHERE card_id = ? ORDER BY phase, kind, round`,
        args: [cardId],
      }),
      this.client.execute({
        sql: `SELECT hf.comment_id, COALESCE(ic.author, 'unknown') AS author, hf.spec_id, hf.body
              FROM human_feedback hf
              LEFT JOIN ingested_comments ic ON ic.comment_id = hf.comment_id
              WHERE hf.card_id = ? ORDER BY hf.comment_id`,
        args: [cardId],
      }),
      this.client.execute({
        sql: `SELECT round, failed_scenarios, evidence_dir FROM verify_records
              WHERE card_id = ? ORDER BY round`,
        args: [cardId],
      }),
      this.client.execute({
        // Only this phase's rejections: the prompt presents them as reasons an
        // earlier attempt of this phase was rejected. run_id breaks the tie two
        // rows written in the same millisecond would otherwise leave to SQLite.
        sql: `SELECT phase, failure FROM phase_runs
              WHERE card_id = ? AND phase = ? AND status = 'failed' AND failure IS NOT NULL
              ORDER BY ended_at DESC, started_at DESC, run_id DESC LIMIT 5`,
        args: [cardId, phase],
      }),
    ]);

    const latestVerify = verifyResult.rows.at(-1);
    const failedScenarios = latestVerify
      ? parseStringArray(latestVerify.failed_scenarios, "failed scenarios")
      : [];
    const evidenceDir = latestVerify ? optionalString(latestVerify.evidence_dir) : null;

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
      feedback: feedbackResult.rows.map((row) => {
        const item: PhaseInput["feedback"][number] = {
          id: stringValue(row.comment_id, "feedback id"),
          author: stringValue(row.author, "feedback author"),
          body: stringValue(row.body, "feedback body"),
        };
        const specId = optionalString(row.spec_id);
        if (specId) item.specId = specId;
        return item;
      }),
      evidence: evidenceDir
        ? failedScenarios.map((scenarioId) => ({ scenarioId, path: evidenceDir }))
        : [],
      failedScenarios,
      previousRejections: rejectionResult.rows.map((row) => ({
        phase: stringValue(row.phase, "rejected phase"),
        reason: stringValue(row.failure, "rejection reason").slice(0, 800),
      })),
    };
  }
}

function phaseForState(state: StoryState): StoryPhase | null {
  switch (state) {
    case "DESIGN":
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
