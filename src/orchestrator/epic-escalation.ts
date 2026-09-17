import type { Client } from "@libsql/client";
import { blockingQuestionStatement } from "./epic-blocker.js";
import { unrecoveredHeadFailures, type EpicHeadFailure } from "./epic-head-failure.js";
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
export function escalationReason(parked: readonly ParkedStory[], headFailure?: EpicHeadFailure): string {
  if (headFailure) {
    const stories = parked.map((story) => story.id);
    const line = `Epic head fails ${headFailure.check}: ${headFailure.failures.join(", ")}`;
    return [line, ...(stories.length > 0 ? [reasonOfParked(parked)] : [])].join("; ");
  }
  return reasonOfParked(parked);
}

function reasonOfParked(parked: readonly ParkedStory[]): string {
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
export function escalationQuestion(
  parked: readonly ParkedStory[],
  headFailure?: EpicHeadFailure,
): HumanQuestion {
  const byReason = new Map<string, string[]>();
  for (const story of parked) {
    const key = story.stopReason ?? UNKNOWN_STOP;
    byReason.set(key, [...(byReason.get(key) ?? []), story.id]);
  }
  const labels = text.stopReasons as Record<string, string | undefined>;
  const lines = [...byReason.entries()].map(([reason, ids]) =>
    text.questionTemplate.replace("{stories}", ids.join(", ")).replace("{reason}", labels[reason] ?? reason));
  if (headFailure) {
    // Nothing is asked of the person about the Story: it is finished and the
    // branch under it is not. Saying so is what keeps somebody from going to
    // the card and looking for a defect that is not there.
    lines.unshift(text.headFailingTemplate
      .replace("{check}", headFailure.check)
      .replace("{failures}", headFailure.failures.join(", "))
      .replace("{stories}", headFailure.storyId));
  }
  return { question: lines.join("\n"), options: [] };
}

/**
 * Every way a Story stops needing the machine and starts needing a person. A
 * card a person parked and a card that failed are as stuck as one that asked a
 * question: the Epic they belong to is not progressing, and a board that shows
 * it as executing is telling the person nothing is expected of them.
 */
const STALLED_STORY_STATES = ["NEEDS_INPUT", "HUMAN_PARKED", "FAILED"] as const;

/** What the person is told when the state itself is the reason. */
const STATE_REASON: Record<string, string> = { HUMAN_PARKED: "human_parked", FAILED: "failed" };

async function parkedStoriesByEpic(client: Client, epicState: string): Promise<Map<string, ParkedStory[]>> {
  const placeholders = STALLED_STORY_STATES.map(() => "?").join(", ");
  const rows = (await client.execute({
    sql: `SELECT e.id AS epic_id, s.id AS story_id, s.state AS story_state, s.stop_reason
          FROM epics e JOIN stories s ON s.epic_id = e.id
          WHERE e.state = ? AND s.state IN (${placeholders})
          ORDER BY e.id, s.id`,
    args: [epicState, ...STALLED_STORY_STATES],
  })).rows;
  const grouped = new Map<string, ParkedStory[]>();
  for (const row of rows) {
    const epicId = String(row.epic_id);
    const stopReason = row.stop_reason === null
      ? STATE_REASON[String(row.story_state)] ?? null
      : String(row.stop_reason);
    grouped.set(epicId, [...(grouped.get(epicId) ?? []), {
      id: String(row.story_id),
      stopReason: stopReason as StoryStopReason | null,
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

  // Two independent reasons an Epic is not progressing: a Story of its own
  // that stopped, and its head failing a check nobody's Story can fix.
  const headFailures = await unrecoveredHeadFailures(client);
  const toBlock = await parkedStoriesByEpic(client, "EXECUTING");
  for (const epicId of executingEpicsToBlock(toBlock, headFailures, await executingEpics(client))) {
    const parked = toBlock.get(epicId) ?? [];
    const headFailure = headFailures.get(epicId);
    assertEpicTransition("EXECUTING", "BLOCKED");
    const storyIds = parked.map((story) => story.id);
    const question = escalationQuestion(parked, headFailure);
    const time = now();
    const runId = `epic:${epicId}`;
    const data = {
      from: "EXECUTING", to: "BLOCKED", reason: escalationReason(parked, headFailure), question, escalation: true, storyIds,
      ...(headFailure ? { headFailure: { check: headFailure.check, failures: headFailure.failures, storyId: headFailure.storyId } } : {}),
    };
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
    // Both sources have to be clear: a head that is still red would send the
    // same Story back into a merge that cannot succeed.
    if (stillParked.has(epicId) || headFailures.has(epicId)) continue;
    const latest = await latestTransition(client, epicId);
    if (latest?.to !== "BLOCKED" || latest.escalation !== true) continue;
    assertEpicTransition("BLOCKED", "EXECUTING");
    const storyIds = Array.isArray(latest.storyIds) ? latest.storyIds.map(String) : [];
    const time = now();
    const runId = `epic:${epicId}`;
    const data = { from: "BLOCKED", to: "EXECUTING", reason: "the Epic has nothing waiting on a person", escalation: true, storyIds };
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

async function executingEpics(client: Client): Promise<string[]> {
  return (await client.execute("SELECT id FROM epics WHERE state = 'EXECUTING' ORDER BY id")).rows
    .map((row) => String(row.id));
}

/** Executing Epics with something to block on, in a stable order. */
function executingEpicsToBlock(
  parked: Map<string, ParkedStory[]>,
  headFailures: Map<string, EpicHeadFailure>,
  executing: readonly string[],
): string[] {
  return executing.filter((epicId) => parked.has(epicId) || headFailures.has(epicId));
}
