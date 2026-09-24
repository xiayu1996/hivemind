import type { Client, InStatement } from "@libsql/client";
import { payloadHash } from "../notion/outbox.js";
import {
  annotateReply,
  humanQuestionInputSchema,
  normalizeQuestion,
  questionText,
  replyHint,
  type HumanQuestion,
} from "./human-question.js";
import { epicTransitionStatement } from "./state-machine.js";
import escalationText from "./epic-escalation-text.json" with { type: "json" };

export const COMMENT_EPIC_PAGE = "comment_epic_page";

const QUESTION_PREFIX = "blocking question: ";

export interface BlockerAnswer {
  question: string;
  answer: string;
}

/**
 * Why an Epic is blocked. A decomposition block asks a question that the
 * person answers on the Epic page; an escalation block only reports that a
 * Story is waiting, and is answered on that Story's page.
 */
export interface EpicBlock {
  question: HumanQuestion;
  escalation: boolean;
}

/** What the person reads on the Epic page when the Epic had to stop. */
export function blockingQuestionBody(question: HumanQuestion, escalation = false): string {
  if (escalation) return `${escalationText.bodyPrefix}${questionText(question)}\n\n${escalationText.bodySuffix}`;
  return `[拆解阻塞问题] ${questionText(question)}\n\n${replyHint([question])}拆解会带着你的回答重新进行。`;
}

/** The last block recorded for the Epic, read back from the transition that
 * recorded it. Transitions written before questions were structured carry
 * only the reason line, which is the question itself. */
export async function latestBlock(client: Client, epicId: string): Promise<EpicBlock | null> {
  const rows = (await client.execute({
    sql: "SELECT data FROM event_log WHERE run_id = ? AND type = 'epic.transition' ORDER BY seq DESC",
    args: [`epic:${epicId}`],
  })).rows;
  for (const row of rows) {
    const data = JSON.parse(String(row.data)) as { to?: string; reason?: string; question?: unknown; escalation?: unknown };
    if (data.to !== "BLOCKED") continue;
    const escalation = data.escalation === true;
    const structured = humanQuestionInputSchema.safeParse(data.question);
    if (structured.success) return { question: normalizeQuestion(structured.data), escalation };
    if (data.reason === undefined) return null;
    const reason = data.reason.startsWith(QUESTION_PREFIX) ? data.reason.slice(QUESTION_PREFIX.length) : data.reason;
    return { question: normalizeQuestion(reason), escalation };
  }
  return null;
}

export async function latestBlockingQuestion(client: Client, epicId: string): Promise<HumanQuestion | null> {
  return (await latestBlock(client, epicId))?.question ?? null;
}

/**
 * The outbox row that puts a blocking question on the Epic page. A stop the
 * board never shows is a stop nobody answers; the payload is constant per
 * question so re-running this after a restart adds nothing.
 */
export function blockingQuestionStatement(
  epicId: string,
  question: HumanQuestion,
  time: number,
  escalation = false,
): InStatement {
  const encoded = payloadHash({ epicId, body: blockingQuestionBody(question, escalation) });
  return {
    sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
          VALUES (?, 1, ?, ?, ?, ?, ?)
          ON CONFLICT(target, payload_hash) DO NOTHING`,
    args: [epicId, COMMENT_EPIC_PAGE, `epic-comment:${epicId}`, encoded.json, encoded.hash, time],
  };
}

/** Puts every blocked Epic's question on its page; safe to call each cycle. */
export async function surfaceBlockedEpics(client: Client, now: () => number = Date.now): Promise<string[]> {
  const blocked = (await client.execute("SELECT id FROM epics WHERE state = 'BLOCKED' ORDER BY id")).rows;
  const surfaced: string[] = [];
  for (const row of blocked) {
    const epicId = String(row.id);
    const block = await latestBlock(client, epicId);
    if (!block) continue;
    await client.execute(blockingQuestionStatement(epicId, block.question, now(), block.escalation));
    surfaced.push(epicId);
  }
  return surfaced;
}

/** Every answer a person has given this Epic's blocking questions, oldest first. */
export async function blockerAnswers(client: Client, epicId: string): Promise<BlockerAnswer[]> {
  const rows = (await client.execute({
    sql: "SELECT data FROM event_log WHERE run_id = ? AND type = 'epic.blocker_answered' ORDER BY seq",
    args: [`epic:${epicId}`],
  })).rows;
  return rows.map((row) => {
    const data = JSON.parse(String(row.data)) as BlockerAnswer;
    return { question: data.question, answer: data.answer };
  });
}

/** The requirement as the decomposer should read it: the page's words, then
 * what the person answered when decomposition asked. */
export function withBlockerAnswers(requirement: string, answers: readonly BlockerAnswer[]): string {
  if (answers.length === 0) return requirement;
  const lines = answers.map((item) => `问：${item.question}\n答：${item.answer}`);
  return `${requirement}\n\n补充说明（拆解时提出的问题与回答）：\n${lines.join("\n\n")}`;
}

/** The event row that records what a person asked to be changed about a plan.
 * It lands in the same batch as the transition, so there is never a moment
 * where the plan was sent back and nobody knows why. */
export function planRevisionStatement(epicId: string, feedback: string, time: number): InStatement {
  const runId = `epic:${epicId}`;
  return {
    sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
          VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                  ?, 'DECOMPOSE', 'epic.plan_revision_requested', ?, ?)`,
    args: [runId, runId, epicId, time, JSON.stringify({ feedback })],
  };
}

/** What a person asked to be changed about a plan, in the order they said it. */
export async function planRevisionFeedback(client: Client, epicId: string): Promise<string[]> {
  const rows = (await client.execute({
    sql: "SELECT data FROM event_log WHERE run_id = ? AND type = 'epic.plan_revision_requested' ORDER BY seq",
    args: [`epic:${epicId}`],
  })).rows;
  return rows.map((row) => String((JSON.parse(String(row.data)) as { feedback: string }).feedback));
}

/**
 * The requirement as the decomposer should read it after a plan was sent back:
 * the page's words, then what the person said was wrong with the last split.
 * Without this the next attempt has no reason to produce anything different.
 */
export function withPlanRevisions(requirement: string, revisions: readonly string[]): string {
  if (revisions.length === 0) return requirement;
  return `${requirement}\n\n上一版拆解方案被退回，人提出的意见：\n${revisions.map((item) => `- ${item}`).join("\n")}`;
}

/**
 * A person's comment on a blocked Epic is the answer. It is claimed under the
 * comment id so a second delivery changes nothing, and the Epic goes back to
 * decomposition carrying the answer. An escalation block is not a question
 * about the requirement: its Stories already exist and some are delivered, so
 * a comment must not send the Epic back to decomposition. The Story page is
 * where that answer belongs, and the Epic resumes on its own.
 */
export async function answerBlocker(
  client: Client,
  epicId: string,
  commentId: string,
  answer: string,
  now: () => number = Date.now,
): Promise<boolean> {
  if (answer.trim() === "") return false;
  const block = await latestBlock(client, epicId);
  if (block === null || block.escalation) return false;
  const asked = block.question;
  // The letters a person typed are expanded next to their words so the
  // decomposer reads what was chosen, not which key was pressed.
  const question = questionText(asked);
  const resolved = annotateReply([asked], answer.trim());
  const time = now();
  const runId = `epic:${epicId}`;
  const results = await client.batch([
    {
      sql: `INSERT OR IGNORE INTO epic_approval_events (event_id, epic_id, source, created_at)
            VALUES (?, ?, 'comment', ?)`,
      args: [commentId, epicId, time],
    },
    epicTransitionStatement({ epicId, from: "BLOCKED", to: "DECOMPOSE", at: time }),
    {
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                   NULL, 'DECOMPOSE', 'epic.blocker_answered', ?, ?
            WHERE EXISTS (SELECT 1 FROM epics WHERE id = ? AND state = 'DECOMPOSE')`,
      args: [runId, runId, time, JSON.stringify({ question, answer: resolved, commentId }), epicId],
    },
  ], "write");
  return results[1]?.rowsAffected === 1;
}
