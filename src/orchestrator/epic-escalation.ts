import type { Client } from "@libsql/client";
import { blockingQuestionStatement } from "./epic-blocker.js";
import type { HumanQuestion } from "./human-question.js";
import { assertEpicTransition, type StoryStopReason } from "./state-machine.js";
import text from "./epic-escalation-text.json" with { type: "json" };

export interface EscalationChange {
  epicId: string;
  storyIds: string[];
  kind: "blocked" | "unblocked";
}

interface ParkedStory {
  id: string;
  stopReason: StoryStopReason | null;
}

const UNKNOWN_STOP = "unknown";

/** The reason line as the event log and operators read it. */
export function escalationReason(parked: readonly ParkedStory[]): string {
  const byReason = new Map<string, string[]>();
  for (const story of parked) {
    const key = story.stopReason ?? UNKNOWN_STOP;
    byReason.set(key, [...(byReason.get(key) ?? []), story.id]);
  }
  return [...byReason.entries()]
    .map(([reason, ids]) => `Story ${ids.join(", ")} stopped: ${reason}`)
    .join("; ");
}

/** The same fact in the person's words, one line per stop reason, no options:
 * the answer is given on the Story page, not here. */
export function escalationQuestion(parked: readonly ParkedStory[]): HumanQuestion {
  const byReason = new Map<string, string[]>();
  for (const story of parked) {
    const key = story.stopReason ?? UNKNOWN_STOP;
    byReason.set(key, [...(byReason.get(key) ?? []), story.id]);
  }
  const labels = text.stopReasons as Record<string, string | undefined>;
  const lines = [...byReason.entries()].map(([reason, ids]) =>
    text.questionTemplate.replace("{stories}", ids.join(", ")).replace("{reason}", labels[reason] ?? reason));
  return { question: lines.join("\n"), options: [] };
}

async function parkedStoriesByEpic(client: Client, epicState: string): Promise<Map<string, ParkedStory[]>> {
  const rows = (await client.execute({
    sql: `SELECT e.id AS epic_id, s.id AS story_id, s.stop_reason
          FROM epics e JOIN stories s ON s.epic_id = e.id
          WHERE e.state = ? AND s.state = 'NEEDS_INPUT'
          ORDER BY e.id, s.id`,
    args: [epicState],
  })).rows;
  const grouped = new Map<string, ParkedStory[]>();
  for (const row of rows) {
    const epicId = String(row.epic_id);
    grouped.set(epicId, [...(grouped.get(epicId) ?? []), {
      id: String(row.story_id),
      stopReason: row.stop_reason === null ? null : (String(row.stop_reason) as StoryStopReason),
    }]);
  }
  return grouped;
}

async function latestTransition(client: Client, epicId: string): Promise<Record<string, unknown> | null> {
  const row = (await client.execute({
    sql: "SELECT data FROM event_log WHERE run_id = ? AND type = 'epic.transition' ORDER BY seq DESC LIMIT 1",
    args: [`epic:${epicId}`],
  })).rows[0];
  return row ? JSON.parse(String(row.data)) as Record<string, unknown> : null;
}

/**
 * Makes a stuck Epic look stuck. A Story in NEEDS_INPUT stops its Epic as
 * surely as an unanswered decomposition question, but without this the Epic
 * stays EXECUTING and nobody reading the board learns that it waits. The Epic
 * is blocked with a transition carrying `escalation: true`; that flag is what
 * keeps a comment on the Epic page from sending it back to decomposition, and
 * what lets this function recognise its own block and lift it once every
 * Story has moved on. Both directions are conditional updates, so running it
 * again in the same cycle changes nothing.
 */
export async function escalateParkedStories(
  client: Client,
  now: () => number = Date.now,
): Promise<EscalationChange[]> {
  const changes: EscalationChange[] = [];

  const toBlock = await parkedStoriesByEpic(client, "EXECUTING");
  for (const [epicId, parked] of toBlock) {
    assertEpicTransition("EXECUTING", "BLOCKED");
    const storyIds = parked.map((story) => story.id);
    const question = escalationQuestion(parked);
    const time = now();
    const runId = `epic:${epicId}`;
    const data = { from: "EXECUTING", to: "BLOCKED", reason: escalationReason(parked), question, escalation: true, storyIds };
    const results = await client.batch([
      {
        sql: "UPDATE epics SET state = 'BLOCKED', updated_at = ? WHERE id = ? AND state = 'EXECUTING'",
        args: [time, epicId],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?), NULL, NULL, 'epic.transition', ?, ?
              WHERE EXISTS (SELECT 1 FROM epics WHERE id = ? AND state = 'BLOCKED' AND updated_at = ?)`,
        args: [runId, runId, time, JSON.stringify(data), epicId, time],
      },
      blockingQuestionStatement(epicId, question, time, true),
    ], "write");
    if (results[0]?.rowsAffected === 1) changes.push({ epicId, storyIds, kind: "blocked" });
  }

  const blocked = (await client.execute("SELECT id FROM epics WHERE state = 'BLOCKED' ORDER BY id")).rows;
  const stillParked = await parkedStoriesByEpic(client, "BLOCKED");
  for (const row of blocked) {
    const epicId = String(row.id);
    if (stillParked.has(epicId)) continue;
    const latest = await latestTransition(client, epicId);
    if (latest?.to !== "BLOCKED" || latest.escalation !== true) continue;
    assertEpicTransition("BLOCKED", "EXECUTING");
    const storyIds = Array.isArray(latest.storyIds) ? latest.storyIds.map(String) : [];
    const time = now();
    const runId = `epic:${epicId}`;
    const data = { from: "BLOCKED", to: "EXECUTING", reason: "parked Stories resumed", escalation: true, storyIds };
    const results = await client.batch([
      {
        sql: "UPDATE epics SET state = 'EXECUTING', updated_at = ? WHERE id = ? AND state = 'BLOCKED'",
        args: [time, epicId],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?), NULL, NULL, 'epic.transition', ?, ?
              WHERE EXISTS (SELECT 1 FROM epics WHERE id = ? AND state = 'EXECUTING' AND updated_at = ?)`,
        args: [runId, runId, time, JSON.stringify(data), epicId, time],
      },
    ], "write");
    if (results[0]?.rowsAffected === 1) changes.push({ epicId, storyIds, kind: "unblocked" });
  }

  return changes;
}
