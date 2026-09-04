import type { Client } from "@libsql/client";
import { normalizeQuestion, parseQuestions, type HumanQuestion, type HumanQuestionInput } from "./human-question.js";
import {
  assertRequirementTransition,
  type RequirementState,
} from "./requirement-machine.js";
import type { TransitionActor } from "./state-machine.js";

export interface RequirementIntake {
  id: string;
  notionPageId: string;
  title: string;
  originalRequest: string;
  repo?: string;
}

export interface RequirementSnapshot extends RequirementIntake {
  state: RequirementState;
  clarifyRounds: number;
  stopReason: string | null;
  resumeState: RequirementState | null;
}

export interface ClarifyRound {
  round: number;
  questions: HumanQuestion[];
  askedAt: number;
  answers: string[] | null;
}

export interface PrdRevision {
  revision: number;
  body: string;
  status: "draft" | "confirmed" | "superseded";
}

export interface AcceptanceItem {
  itemId: string;
  prdScenarioId: string;
  text: string;
  status: "open" | "accepted" | "gap";
  notionBlockId: string | null;
}

export type ApprovalKind = "prd_confirm" | "prd_revision" | "acceptance";
export type ApprovalSource = "comment" | "drag";

export type RequirementNotionSection = "metadata" | "original" | "clarify" | "prd" | "acceptance";

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (typeof value !== "string") throw new Error(`${label} is not JSON text`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${label} is not an array of strings`);
  }
  return parsed;
}

function eventStatement(
  runId: string,
  requirementId: string,
  type: string,
  data: unknown,
  time: number,
): { sql: string; args: Array<string | number | null> } {
  return {
    sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
          VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                  ?, NULL, ?, ?, ?)`,
    args: [runId, runId, requirementId, type, time, JSON.stringify(data)],
  };
}

/**
 * Execution truth for the requirement layer that sits above Epics: what the
 * human asked for, what the product manager asked back, the PRD they froze
 * together, and the scenario-level verdicts that close it.
 */
export class RequirementStore {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  /** False when the page was already taken in, which is the normal outcome of
   * a poll re-reading a board it has already seen. */
  async createRequirement(input: RequirementIntake): Promise<boolean> {
    if (input.originalRequest.trim() === "") throw new Error("requirement text must not be empty");
    const time = this.now();
    const [insert] = await this.client.batch([
      {
        sql: `INSERT OR IGNORE INTO requirements
                (id, notion_page_id, title, state, original_request, repo, created_at, updated_at)
              VALUES (?, ?, ?, 'CLARIFY', ?, ?, ?, ?)`,
        args: [input.id, input.notionPageId, input.title, input.originalRequest, input.repo ?? null, time, time],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, 0, ?, NULL, 'requirement.intake', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM requirements WHERE id = ? AND notion_page_id = ? AND created_at = ?
              ) AND NOT EXISTS (SELECT 1 FROM event_log WHERE run_id = ?)`,
        args: [
          `requirement-intake:${input.id}`,
          input.id,
          time,
          JSON.stringify({ notionPageId: input.notionPageId, title: input.title }),
          input.id,
          input.notionPageId,
          time,
          `requirement-intake:${input.id}`,
        ],
      },
    ], "write");
    return insert?.rowsAffected === 1;
  }

  async getRequirement(id: string): Promise<RequirementSnapshot> {
    const row = (await this.client.execute({
      sql: `SELECT id, notion_page_id, title, state, original_request, clarify_rounds,
                   stop_reason, resume_state, repo
            FROM requirements WHERE id = ?`,
      args: [id],
    })).rows[0];
    if (!row) throw new Error(`requirement does not exist: ${id}`);
    const repo = optionalString(row.repo);
    return {
      id: stringValue(row.id, "requirement id"),
      notionPageId: stringValue(row.notion_page_id, "Notion page id"),
      title: stringValue(row.title, "requirement title"),
      state: stringValue(row.state, "requirement state") as RequirementState,
      originalRequest: stringValue(row.original_request, "original request"),
      clarifyRounds: Number(row.clarify_rounds),
      stopReason: optionalString(row.stop_reason),
      resumeState: optionalString(row.resume_state) as RequirementState | null,
      ...(repo ? { repo } : {}),
    };
  }

  /** Requirements the loop may act on: a stopped one is waiting for a human and
   * must not be picked up again until the answer clears the stop. */
  async listActionable(state: RequirementState): Promise<RequirementSnapshot[]> {
    const rows = (await this.client.execute({
      sql: "SELECT id FROM requirements WHERE state = ? AND stop_reason IS NULL ORDER BY created_at, id",
      args: [state],
    })).rows;
    const snapshots: RequirementSnapshot[] = [];
    for (const row of rows) snapshots.push(await this.getRequirement(stringValue(row.id, "requirement id")));
    return snapshots;
  }

  async transition(
    id: string,
    expectedFrom: RequirementState,
    to: RequirementState,
    actor: TransitionActor,
    runId: string,
    parkedResumeState?: RequirementState,
  ): Promise<void> {
    assertRequirementTransition(expectedFrom, to, actor, parkedResumeState);
    const time = this.now();
    const resumeState = to === "HUMAN_PARKED" ? expectedFrom : null;
    const [update] = await this.client.batch([
      {
        sql: `UPDATE requirements
              SET state = ?, stop_reason = NULL, resume_state = ?, updated_at = ?
              WHERE id = ? AND state = ?`,
        args: [to, resumeState, time, id, expectedFrom],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                     ?, NULL, 'requirement.transition', ?, ?
              WHERE EXISTS (SELECT 1 FROM requirements WHERE id = ? AND state = ? AND updated_at = ?)`,
        args: [runId, runId, id, time, JSON.stringify({ from: expectedFrom, to, actor }), id, to, time],
      },
    ], "write");
    if (update?.rowsAffected !== 1) {
      throw new Error(`requirement transition lost a race: ${id} is no longer ${expectedFrom}`);
    }
  }

  /**
   * The requirement keeps its state and waits for a person. Clarification does
   * not get a stop of its own kind: exhausting the question budget is the same
   * blocking_question the Story layer already knows how to surface.
   */
  async stopForHumanInput(id: string, expectedState: RequirementState, runId: string, detail: string): Promise<void> {
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE requirements SET stop_reason = 'blocking_question', updated_at = ?
              WHERE id = ? AND state = ? AND stop_reason IS NULL`,
        args: [time, id, expectedState],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                     ?, NULL, 'requirement.stopped', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM requirements
                WHERE id = ? AND state = ? AND stop_reason = 'blocking_question' AND updated_at = ?
              )`,
        args: [runId, runId, id, time, JSON.stringify({ state: expectedState, detail }), id, expectedState, time],
      },
    ], "write");
    if (update?.rowsAffected !== 1) {
      throw new Error(`requirement stop lost a race: ${id} is not an unstopped ${expectedState}`);
    }
  }

  /** A human answered, so the loop may run again from the same state. */
  async clearStop(id: string, runId: string): Promise<boolean> {
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: "UPDATE requirements SET stop_reason = NULL, last_human_action_at = ?, updated_at = ? WHERE id = ? AND stop_reason IS NOT NULL",
        args: [time, time, id],
      },
      eventStatement(runId, id, "requirement.resumed", {}, time),
    ], "write");
    return update?.rowsAffected === 1;
  }

  /**
   * Opens the next question batch. A round stays open until its answers are
   * read back, so a crash between posting and reading replays the read rather
   * than asking the person the same questions twice.
   */
  async openClarifyRound(id: string, asked: readonly HumanQuestionInput[], runId: string): Promise<number> {
    const questions = asked.map(normalizeQuestion);
    if (questions.length === 0) throw new Error("a clarification round must ask at least one question");
    const requirement = await this.getRequirement(id);
    const open = await this.latestClarifyRound(id);
    if (open && open.answers === null) {
      throw new Error(`clarification round ${open.round} is still waiting for answers`);
    }
    const round = requirement.clarifyRounds + 1;
    const time = this.now();
    const [insert] = await this.client.batch([
      {
        sql: `INSERT INTO requirement_clarify_rounds (requirement_id, round, questions, asked_at)
              VALUES (?, ?, ?, ?)`,
        args: [id, round, JSON.stringify(questions), time],
      },
      {
        sql: "UPDATE requirements SET clarify_rounds = ?, updated_at = ? WHERE id = ? AND clarify_rounds = ?",
        args: [round, time, id, requirement.clarifyRounds],
      },
      eventStatement(runId, id, "requirement.clarify_asked", { round, questionCount: questions.length }, time),
    ], "write");
    if (insert?.rowsAffected !== 1) throw new Error(`clarification round ${round} already exists for ${id}`);
    return round;
  }

  async recordClarifyAnswers(id: string, round: number, answers: string[], runId: string): Promise<boolean> {
    if (answers.length === 0) throw new Error("recording answers needs at least one answer");
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE requirement_clarify_rounds SET answers = ?, answered_at = ?
              WHERE requirement_id = ? AND round = ? AND answered_at IS NULL`,
        args: [JSON.stringify(answers), time, id, round],
      },
      eventStatement(runId, id, "requirement.clarify_answered", { round, answerCount: answers.length }, time),
    ], "write");
    return update?.rowsAffected === 1;
  }

  async clarifyHistory(id: string): Promise<ClarifyRound[]> {
    const rows = (await this.client.execute({
      sql: `SELECT round, questions, asked_at, answers FROM requirement_clarify_rounds
            WHERE requirement_id = ? ORDER BY round`,
      args: [id],
    })).rows;
    return rows.map((row) => ({
      round: Number(row.round),
      questions: parseQuestions(row.questions, "clarification questions"),
      askedAt: Number(row.asked_at),
      answers: row.answers === null ? null : parseStringArray(row.answers, "clarification answers"),
    }));
  }

  async latestClarifyRound(id: string): Promise<ClarifyRound | null> {
    const history = await this.clarifyHistory(id);
    return history.at(-1) ?? null;
  }

  /**
   * A rewrite never edits what a human read: the new revision supersedes every
   * older one, so the exact text behind any past confirmation stays readable.
   */
  async saveDraftPrd(id: string, body: string, runId: string): Promise<number> {
    JSON.parse(body) as unknown;
    const existing = (await this.client.execute({
      sql: `SELECT COALESCE(MAX(revision), 0) AS revision,
                   SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
            FROM requirement_prds WHERE requirement_id = ?`,
      args: [id],
    })).rows[0];
    // Confirmation freezes the PRD: what the person approved is what gets
    // built. Changing it afterwards is a new requirement, not a redraft.
    if (Number(existing?.confirmed) > 0) throw new Error(`PRD of ${id} is confirmed and cannot be redrafted`);
    const current = Number(existing?.revision);
    const revision = current + 1;
    const time = this.now();
    const [, insert] = await this.client.batch([
      {
        sql: `UPDATE requirement_prds SET status = 'superseded'
              WHERE requirement_id = ? AND status <> 'superseded'`,
        args: [id],
      },
      {
        sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at)
              VALUES (?, ?, ?, 'draft', ?)`,
        args: [id, revision, body, time],
      },
      eventStatement(runId, id, "requirement.prd_drafted", { revision }, time),
    ], "write");
    if (insert?.rowsAffected !== 1) throw new Error(`PRD revision ${revision} already exists for ${id}`);
    return revision;
  }

  async getPrd(id: string, revision?: number): Promise<PrdRevision | null> {
    const row = revision === undefined
      ? (await this.client.execute({
          sql: "SELECT revision, body, status FROM requirement_prds WHERE requirement_id = ? ORDER BY revision DESC LIMIT 1",
          args: [id],
        })).rows[0]
      : (await this.client.execute({
          sql: "SELECT revision, body, status FROM requirement_prds WHERE requirement_id = ? AND revision = ?",
          args: [id, revision],
        })).rows[0];
    if (!row) return null;
    return {
      revision: Number(row.revision),
      body: stringValue(row.body, "PRD body"),
      status: stringValue(row.status, "PRD status") as PrdRevision["status"],
    };
  }

  /**
   * Records a human approval exactly once. Webhook and polling deliveries name
   * the same event id, so the loser learns it lost instead of confirming twice.
   */
  async claimApprovalEvent(
    id: string,
    eventId: string,
    kind: ApprovalKind,
    source: ApprovalSource,
  ): Promise<boolean> {
    const result = await this.client.execute({
      sql: `INSERT OR IGNORE INTO requirement_approval_events (event_id, requirement_id, kind, source, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [eventId, id, kind, source, this.now()],
    });
    return result.rowsAffected === 1;
  }

  /** False when this confirmation was already applied by another delivery. */
  async confirmPrd(
    id: string,
    revision: number,
    eventId: string,
    source: ApprovalSource,
    runId: string,
  ): Promise<boolean> {
    if (!(await this.claimApprovalEvent(id, eventId, "prd_confirm", source))) return false;
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE requirement_prds SET status = 'confirmed', confirmed_at = ?
              WHERE requirement_id = ? AND revision = ? AND status = 'draft'`,
        args: [time, id, revision],
      },
      {
        sql: "UPDATE requirements SET last_human_action_at = ?, updated_at = ? WHERE id = ?",
        args: [time, time, id],
      },
      eventStatement(runId, id, "requirement.prd_confirmed", { revision, source, eventId }, time),
    ], "write");
    if (update?.rowsAffected !== 1) throw new Error(`PRD revision ${revision} of ${id} is not a draft`);
    return true;
  }

  /**
   * A person asked for changes instead of approving. The draft is retired so
   * the next pass rewrites rather than edits, and their words are kept so the
   * rewrite answers them instead of guessing what displeased them.
   */
  async requestPrdRevision(
    id: string,
    revision: number,
    feedback: string,
    eventId: string,
    source: ApprovalSource,
    runId: string,
  ): Promise<boolean> {
    if (feedback.trim() === "") throw new Error("a revision request must say what to change");
    if (!(await this.claimApprovalEvent(id, eventId, "prd_revision", source))) return false;
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE requirement_prds SET status = 'superseded'
              WHERE requirement_id = ? AND revision = ? AND status = 'draft'`,
        args: [id, revision],
      },
      {
        sql: "UPDATE requirements SET last_human_action_at = ?, updated_at = ? WHERE id = ?",
        args: [time, time, id],
      },
      eventStatement(runId, id, "requirement.prd_revision_requested", { revision, feedback, source }, time),
    ], "write");
    if (update?.rowsAffected !== 1) throw new Error(`PRD revision ${revision} of ${id} is not a draft`);
    return true;
  }

  /** Everything a person has asked to change, oldest first. */
  async prdRevisionFeedback(id: string): Promise<string[]> {
    const rows = (await this.client.execute({
      sql: `SELECT data FROM event_log
            WHERE card_id = ? AND type = 'requirement.prd_revision_requested' ORDER BY ts, id`,
      args: [id],
    })).rows;
    return rows.map((row) => {
      const parsed: unknown = JSON.parse(stringValue(row.data, "event data"));
      const feedback = (parsed as { feedback?: unknown }).feedback;
      if (typeof feedback !== "string") throw new Error("revision event carries no feedback text");
      return feedback;
    });
  }

  /** The scenarios the human will judge, mirrored one-for-one from the PRD the
   * same human confirmed. */
  async seedAcceptanceItems(
    id: string,
    items: Array<{ itemId: string; prdScenarioId: string; text: string }>,
    runId: string,
  ): Promise<void> {
    if (items.length === 0) throw new Error("acceptance needs at least one scenario");
    const time = this.now();
    await this.client.batch([
      ...items.map((item) => ({
        sql: `INSERT OR IGNORE INTO requirement_acceptance_items
                (requirement_id, item_id, prd_scenario_id, text, status, created_at)
              VALUES (?, ?, ?, ?, 'open', ?)`,
        args: [id, item.itemId, item.prdScenarioId, item.text, time],
      })),
      eventStatement(runId, id, "requirement.acceptance_seeded", {
        itemIds: items.map((item) => item.itemId).toSorted(),
      }, time),
    ], "write");
  }

  async bindAcceptanceBlock(id: string, itemId: string, notionBlockId: string): Promise<void> {
    const result = await this.client.execute({
      sql: `UPDATE requirement_acceptance_items SET notion_block_id = ?
            WHERE requirement_id = ? AND item_id = ?`,
      args: [notionBlockId, id, itemId],
    });
    if (result.rowsAffected !== 1) throw new Error(`acceptance item does not exist: ${id}/${itemId}`);
  }

  async acceptanceItems(id: string): Promise<AcceptanceItem[]> {
    const rows = (await this.client.execute({
      sql: `SELECT item_id, prd_scenario_id, text, status, notion_block_id
            FROM requirement_acceptance_items WHERE requirement_id = ? ORDER BY item_id`,
      args: [id],
    })).rows;
    return rows.map((row) => ({
      itemId: stringValue(row.item_id, "acceptance item id"),
      prdScenarioId: stringValue(row.prd_scenario_id, "PRD scenario id"),
      text: stringValue(row.text, "acceptance text"),
      status: stringValue(row.status, "acceptance status") as AcceptanceItem["status"],
      notionBlockId: optionalString(row.notion_block_id),
    }));
  }

  /** False when this verdict was already applied by another delivery. */
  async decideAcceptanceItem(
    id: string,
    itemId: string,
    status: "accepted" | "gap",
    eventId: string,
    source: ApprovalSource,
    runId: string,
    note = "",
  ): Promise<boolean> {
    if (!(await this.claimApprovalEvent(id, eventId, "acceptance", source))) return false;
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE requirement_acceptance_items SET status = ?, decided_at = ?
              WHERE requirement_id = ? AND item_id = ? AND status = 'open'`,
        args: [status, time, id, itemId],
      },
      {
        sql: "UPDATE requirements SET last_human_action_at = ?, updated_at = ? WHERE id = ?",
        args: [time, time, id],
      },
      eventStatement(runId, id, "requirement.acceptance_decided", { itemId, status, source, eventId, note }, time),
    ], "write");
    if (update?.rowsAffected !== 1) throw new Error(`acceptance item is not open: ${id}/${itemId}`);
    return true;
  }

  /** What the person said was missing, per scenario, latest word per item. */
  async acceptanceGapNotes(id: string): Promise<Map<string, string>> {
    const rows = (await this.client.execute({
      sql: `SELECT data FROM event_log
            WHERE card_id = ? AND type = 'requirement.acceptance_decided' ORDER BY ts, id`,
      args: [id],
    })).rows;
    const notes = new Map<string, string>();
    for (const row of rows) {
      const parsed = JSON.parse(stringValue(row.data, "event data")) as
        { itemId?: unknown; status?: unknown; note?: unknown };
      if (parsed.status !== "gap" || typeof parsed.itemId !== "string") continue;
      notes.set(parsed.itemId, typeof parsed.note === "string" ? parsed.note : "");
    }
    return notes;
  }

  /**
   * Puts the scenarios a person rejected back up for judgement once the work
   * that closes them is under way. Scenarios already accepted stay accepted:
   * making someone re-judge what they already approved teaches them to click
   * through the list without reading it.
   */
  async reopenAcceptanceGaps(id: string, runId: string): Promise<number> {
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE requirement_acceptance_items SET status = 'open', decided_at = NULL
              WHERE requirement_id = ? AND status = 'gap'`,
        args: [id],
      },
      eventStatement(runId, id, "requirement.acceptance_gaps_reopened", {}, time),
    ], "write");
    return update?.rowsAffected ?? 0;
  }

  async registerNotionSection(
    id: string,
    section: RequirementNotionSection,
    anchorBlockId: string,
  ): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO requirement_notion_sections (requirement_id, section, anchor_block_id)
            VALUES (?, ?, ?)
            ON CONFLICT(requirement_id, section) DO UPDATE SET anchor_block_id = excluded.anchor_block_id`,
      args: [id, section, anchorBlockId],
    });
  }

  async notionSections(id: string): Promise<Partial<Record<RequirementNotionSection, string>>> {
    const rows = (await this.client.execute({
      sql: "SELECT section, anchor_block_id FROM requirement_notion_sections WHERE requirement_id = ?",
      args: [id],
    })).rows;
    const sections: Partial<Record<RequirementNotionSection, string>> = {};
    for (const row of rows) {
      sections[stringValue(row.section, "section") as RequirementNotionSection] =
        stringValue(row.anchor_block_id, "anchor block id");
    }
    return sections;
  }

  /** Epics born from this requirement, with the state each one reached; the
   * requirement cannot reach acceptance until they are all done. */
  async linkedEpicStates(id: string): Promise<Array<{ epicId: string; state: string }>> {
    const rows = (await this.client.execute({
      sql: "SELECT id, state FROM epics WHERE requirement_id = ? ORDER BY id",
      args: [id],
    })).rows;
    return rows.map((row) => ({
      epicId: stringValue(row.id, "Epic id"),
      state: stringValue(row.state, "Epic state"),
    }));
  }
}
