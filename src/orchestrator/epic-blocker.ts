import type { Client, InStatement } from "@libsql/client";
import { payloadHash } from "../notion/outbox.js";
import { assertEpicTransition } from "./state-machine.js";

export const COMMENT_EPIC_PAGE = "comment_epic_page";

const QUESTION_PREFIX = "blocking question: ";

export interface BlockerAnswer {
  question: string;
  answer: string;
}

/** What the person reads on the Epic page when decomposition had to stop. */
export function blockingQuestionBody(question: string): string {
  return `[拆解阻塞问题] ${question}\n\n直接回复这条评论即可，拆解会带着你的回答重新进行。`;
}

/** The question the last block raised, read back from the transition that recorded it. */
export async function latestBlockingQuestion(client: Client, epicId: string): Promise<string | null> {
  const rows = (await client.execute({
    sql: "SELECT data FROM event_log WHERE run_id = ? AND type = 'epic.transition' ORDER BY seq DESC",
    args: [`epic:${epicId}`],
  })).rows;
  for (const row of rows) {
    const data = JSON.parse(String(row.data)) as { to?: string; reason?: string };
    if (data.to !== "BLOCKED") continue;
    return data.reason?.startsWith(QUESTION_PREFIX) ? data.reason.slice(QUESTION_PREFIX.length) : data.reason ?? null;
  }
  return null;
}

/**
 * The outbox row that puts a blocking question on the Epic page. A stop the
 * board never shows is a stop nobody answers; the payload is constant per
 * question so re-running this after a restart adds nothing.
 */
export function blockingQuestionStatement(epicId: string, question: string, time: number): InStatement {
  const encoded = payloadHash({ epicId, body: blockingQuestionBody(question) });
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
    const question = await latestBlockingQuestion(client, epicId);
    if (!question) continue;
    await client.execute(blockingQuestionStatement(epicId, question, now()));
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

/**
 * A person's comment on a blocked Epic is the answer. It is claimed under the
 * comment id so a second delivery changes nothing, and the Epic goes back to
 * decomposition carrying the answer.
 */
export async function answerBlocker(
  client: Client,
  epicId: string,
  commentId: string,
  answer: string,
  now: () => number = Date.now,
): Promise<boolean> {
  if (answer.trim() === "") return false;
  const question = await latestBlockingQuestion(client, epicId);
  if (question === null) return false;
  assertEpicTransition("BLOCKED", "DECOMPOSE");
  const time = now();
  const runId = `epic:${epicId}`;
  const results = await client.batch([
    {
      sql: `INSERT OR IGNORE INTO epic_approval_events (event_id, epic_id, source, created_at)
            VALUES (?, ?, 'comment', ?)`,
      args: [commentId, epicId, time],
    },
    {
      sql: "UPDATE epics SET state = 'DECOMPOSE', updated_at = ? WHERE id = ? AND state = 'BLOCKED'",
      args: [time, epicId],
    },
    {
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                   NULL, 'DECOMPOSE', 'epic.blocker_answered', ?, ?
            WHERE EXISTS (SELECT 1 FROM epics WHERE id = ? AND state = 'DECOMPOSE')`,
      args: [runId, runId, time, JSON.stringify({ question, answer: answer.trim(), commentId }), epicId],
    },
  ], "write");
  return results[1]?.rowsAffected === 1;
}
