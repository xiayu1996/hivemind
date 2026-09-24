import type { Client } from "@libsql/client";
import { epicTransitionStatement } from "./state-machine.js";

/**
 * Puts an Epic back into decomposition once the criteria that refused it have
 * changed.
 *
 * A split refused by this system's own checks is not a question about the
 * requirement. Nothing a person can type answers "the Story id was the wrong
 * shape", yet a comment is the only way out of BLOCKED, so on 2026-09-18 three
 * Epics of one requirement sat waiting for an answer nobody could give. When
 * the checks or the phase prompt change, that refusal describes a system that
 * no longer exists and the split has earned another attempt.
 *
 * A blocking question is left alone: it is waiting on a person, which is what
 * it should be doing, and reopening it would throw away the question.
 */
export interface DecompositionReopenInput {
  client: Client;
  /**
   * Identifies the criteria in force, so an Epic is retried once per change
   * rather than every cycle. The caller passes the revision of the running
   * installation; an empty string reopens nothing, because a version that
   * cannot be read cannot be compared.
   */
  criteriaVersion: string;
  now?: () => number;
}

/** Marks which criteria an Epic has already been retried under. */
const REOPENED = "epic.decomposition_reopened";

const REJECTED_PREFIX = "decomposition rejected";

export async function reopenRejectedDecompositions(
  input: DecompositionReopenInput,
): Promise<string[]> {
  if (input.criteriaVersion === "") return [];
  const now = input.now ?? Date.now;
  const blocked = (await input.client.execute("SELECT id FROM epics WHERE state = 'BLOCKED'")).rows
    .map((row) => String(row.id));

  const reopened: string[] = [];
  for (const epicId of blocked) {
    const runId = `epic:${epicId}`;
    const events = (await input.client.execute({
      sql: `SELECT type, data FROM event_log WHERE run_id = ? AND type IN ('epic.transition', ?) ORDER BY seq`,
      args: [runId, REOPENED],
    })).rows.map((row) => ({ type: String(row.type), data: String(row.data) }));

    // The refusal that put it here and the versions whose retry it has already
    // spent. A retry is spent by the refusal it produced, not by the reopen
    // that started it: an Epic reopened under v and refused again under v has
    // had its attempt, and offering another is offering the attempt that just
    // failed. Clearing the set on every block instead made the version a
    // counter that reset itself, so R237511RC was re-decomposed every cycle at
    // brain-tier prices and never reached a person.
    let refusedBy: string | null = null;
    let spent = new Set<string>();
    let openedUnder: string | null = null;
    for (const event of events) {
      const parsed = JSON.parse(event.data) as { to?: string; reason?: string; criteriaVersion?: string };
      if (event.type === REOPENED) {
        if (parsed.criteriaVersion) {
          spent.add(parsed.criteriaVersion);
          openedUnder = parsed.criteriaVersion;
        }
        continue;
      }
      if (parsed.to !== "BLOCKED") continue;
      refusedBy = parsed.reason ?? "";
      // Anything older describes a split made from a different requirement,
      // which is why a person answering a question earns a fresh attempt.
      spent = new Set(openedUnder ? [openedUnder] : []);
      openedUnder = null;
    }
    if (refusedBy === null || !refusedBy.startsWith(REJECTED_PREFIX)) continue;
    if (spent.has(input.criteriaVersion)) continue;

    const at = now();
    const reason = "the decomposition criteria changed since this split was refused";
    const [update] = await input.client.batch([
      epicTransitionStatement({ epicId, from: "BLOCKED", to: "DECOMPOSE", at }),
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                      NULL, 'DECOMPOSE', ?, ?, ?)`,
        args: [runId, runId, REOPENED, at, JSON.stringify({ criteriaVersion: input.criteriaVersion, refusedBy })],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                      NULL, 'DECOMPOSE', 'epic.transition', ?, ?)`,
        args: [runId, runId, at, JSON.stringify({ from: "BLOCKED", to: "DECOMPOSE", reason })],
      },
    ], "write");
    // Lost to whoever moved it first; the winner's record is the true one.
    if (update?.rowsAffected === 1) reopened.push(epicId);
  }
  return reopened;
}
