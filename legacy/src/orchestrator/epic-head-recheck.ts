import type { Client } from "@libsql/client";
import { extractCheckFailures } from "../vcs/check-failures.js";
import { unrecoveredHeadFailures, type EpicHeadFailure } from "./epic-head-failure.js";

export interface HeadCheckPort {
  /** Runs one check in the Epic's own worktree. */
  run(check: string, cwd: string): Promise<{ passed: boolean; detail: string }>;
}

export interface EpicHeadRecheckOptions {
  client: Client;
  checks: HeadCheckPort;
  worktreePath: (epicId: string) => string;
  /** The Epic head as it stands now; a moved head is a reason to look again. */
  headSha: (epicId: string) => Promise<string>;
  /** How long a head that has not moved may go unchecked. */
  intervalMs: number;
  now?: () => number;
}

export type RecheckOutcome =
  | { epicId: string; outcome: "recovered" }
  | { epicId: string; outcome: "still_failing"; failures: readonly string[] }
  | { epicId: string; outcome: "skipped" };

/**
 * Looks again at an Epic head that was failing a check, and clears the block
 * when it is green.
 *
 * The repair usually happens somewhere else entirely - on main, in another
 * Epic, or by a person on the host - so nothing about this Epic announces it.
 * Rechecking every cycle would run the repository's full suite per blocked
 * Epic per cycle, so it only looks when something could have changed: the head
 * moved, somebody acted on the Story waiting on it, or the interval elapsed.
 */
export async function recheckEpicHeads(options: EpicHeadRecheckOptions): Promise<RecheckOutcome[]> {
  const now = options.now ?? Date.now;
  const failures = await unrecoveredHeadFailures(options.client);
  const outcomes: RecheckOutcome[] = [];
  for (const [epicId, failure] of [...failures].toSorted(([left], [right]) => left.localeCompare(right))) {
    const headSha = await options.headSha(epicId).catch(() => failure.headSha);
    if (!(await worthRechecking(options, failure, headSha, now()))) {
      outcomes.push({ epicId, outcome: "skipped" });
      continue;
    }
    const result = await options.checks.run(failure.check, options.worktreePath(epicId));
    const time = now();
    const runId = `epic:${epicId}`;
    if (result.passed) {
      await options.client.execute({
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                      NULL, NULL, 'epic.head_recovered', ?, ?)`,
        args: [runId, runId, time, JSON.stringify({ check: failure.check, headSha, storyId: failure.storyId })],
      });
      outcomes.push({ epicId, outcome: "recovered" });
      continue;
    }
    const failed = extractCheckFailures(failure.check, result.detail);
    // Only a different set is worth another record: the same failure written
    // down every interval buries the one that changed.
    if (failed.join("\u0000") !== [...failure.failures].join("\u0000")) {
      await options.client.execute({
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                      NULL, NULL, 'epic.head_failing', ?, ?)`,
        args: [runId, runId, time, JSON.stringify({
          storyId: failure.storyId, headSha, check: failure.check, failures: failed,
        })],
      });
    }
    outcomes.push({ epicId, outcome: "still_failing", failures: failed });
  }
  return outcomes;
}

async function worthRechecking(
  options: EpicHeadRecheckOptions,
  failure: EpicHeadFailure,
  headSha: string,
  time: number,
): Promise<boolean> {
  if (headSha !== failure.headSha) return true;
  if (time - failure.ts >= options.intervalMs) return true;
  // A fix on the host does not move the branch, so a person touching the
  // waiting Story is the only other signal that something changed.
  const row = (await options.client.execute({
    sql: "SELECT last_human_action_at FROM stories WHERE id = ?",
    args: [failure.storyId],
  })).rows[0];
  return Number(row?.last_human_action_at ?? 0) > failure.ts;
}
