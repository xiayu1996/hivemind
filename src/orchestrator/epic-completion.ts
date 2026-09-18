import type { Client } from "@libsql/client";
import type { MergeRequestState, MergeRequestStatePort } from "../vcs/mr/types.js";
import { EpicAcceptance } from "./epic-acceptance.js";
import { EPIC_BOARD_STATUS, epicStatusStatement } from "./epic-status-projection.js";
import { epicTransitionStatement } from "./state-machine.js";

export type EpicCompletionOutcome =
  | { epicId: string; kind: "done" }
  | { epicId: string; kind: "awaiting_merge" }
  | { epicId: string; kind: "awaiting_acceptance"; open?: number }
  | { epicId: string; kind: "gap"; storyIds: string[] }
  | { epicId: string; kind: "review_closed"; reason: string }
  | { epicId: string; kind: "unreadable"; reason: string };

/**
 * Closes an Epic once its review request has landed and the batch has been
 * judged. Finishing is decided by code, not reported by an agent: the merge is
 * read from the hosting platform, and the human side comes from where the
 * design puts it — an Epic raised from a requirement is accepted scenario by
 * scenario on its own page, while a standalone Epic is accepted by dragging it
 * to the finished column of the board. A review request closed without landing
 * sends the Epic back to EXECUTING with no mr_url, so the next maintenance
 * cycle opens a fresh one instead of waiting on a review nobody will merge.
 */
export class EpicCompletion {
  constructor(
    private readonly client: Client,
    private readonly mergeRequests: MergeRequestStatePort,
    private readonly now: () => number = Date.now,
    private readonly acceptance: EpicAcceptance = new EpicAcceptance(client, now),
  ) {}

  async tick(): Promise<EpicCompletionOutcome[]> {
    const rows = (await this.client.execute(
      `SELECT id, mr_url, requirement_id, notion_status_shadow FROM epics
        WHERE state = 'EPIC_ACCEPT' AND mr_url IS NOT NULL ORDER BY id`,
    )).rows;
    const outcomes: EpicCompletionOutcome[] = [];
    for (const row of rows) {
      const epicId = String(row.id);
      const mrUrl = String(row.mr_url);
      let state: MergeRequestState;
      try {
        state = await this.mergeRequests.state(mrUrl);
      } catch (error) {
        outcomes.push({ epicId, kind: "unreadable", reason: (error as Error).message });
        continue;
      }
      if (state === "open") {
        outcomes.push({ epicId, kind: "awaiting_merge" });
        continue;
      }
      if (state === "closed") {
        const reason = `review request ${mrUrl} was closed without merging`;
        if (await this.reopenExecution(epicId, mrUrl, reason)) outcomes.push({ epicId, kind: "review_closed", reason });
        continue;
      }
      // The Epic landed on the target branch, so its scenarios are now
      // everyone's to keep passing. This follows the merge rather than the
      // business acceptance, and it is the only place a scenario enters the
      // main pool: a Story reaching DELIVERED put its work on the Epic's
      // integration branch, not on main, and promoting there left the main
      // pool claiming to cover code that main did not have.
      await this.client.execute({
        sql: `UPDATE scenario_registry SET pool = 'main', updated_at = ?
               WHERE epic_id = ? AND pool <> 'main'`,
        args: [this.now(), epicId],
      });
      // What the batch promised is judged here, on the batch: the merge says
      // the code landed, and the ticks say it does what was asked for.
      const settled = await this.acceptance.settle(epicId);
      if (settled.kind === "waiting") {
        outcomes.push({ epicId, kind: "awaiting_acceptance", open: settled.open });
        continue;
      }
      if (settled.kind === "gap") {
        outcomes.push({ epicId, kind: "gap", storyIds: settled.storyIds });
        continue;
      }
      // An Epic nobody raised from a requirement has no scenarios to tick, so
      // the one drag to the finished column is what closes it.
      const standalone = settled.kind === "unjudged" && row.requirement_id === null;
      if (standalone && row.notion_status_shadow !== EPIC_BOARD_STATUS.done) {
        outcomes.push({ epicId, kind: "awaiting_acceptance" });
        continue;
      }
      const time = this.now();
      const result = await this.client.batch([
        epicTransitionStatement({ epicId, from: "EPIC_ACCEPT", to: "DONE", at: time }),
        epicStatusStatement(epicId, EPIC_BOARD_STATUS.done, time, "DONE"),
      ], "write");
      if (result[0]?.rowsAffected === 1) outcomes.push({ epicId, kind: "done" });
    }
    return outcomes;
  }

  private async reopenExecution(epicId: string, mrUrl: string, reason: string): Promise<boolean> {
    const time = this.now();
    const runId = `epic-review-closed:${epicId}:${time}`;
    const result = await this.client.batch([
      // Only if the review request it is being sent back from is still the
      // one this run read: another process may have raised a newer one.
      epicTransitionStatement({
        epicId, from: "EPIC_ACCEPT", to: "EXECUTING", at: time, set: { mrUrl: null },
        requires: { sql: "mr_url = ?", args: [mrUrl] },
      }),
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              SELECT ?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                     NULL, 'MERGE', 'epic.review_closed', ?, ?
              WHERE EXISTS (SELECT 1 FROM epics WHERE id = ? AND state = 'EXECUTING' AND mr_url IS NULL)`,
        args: [runId, runId, time, JSON.stringify({ epicId, mrUrl, reason }), epicId],
      },
    ], "write");
    return result[0]?.rowsAffected === 1;
  }
}
