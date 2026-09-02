import type { Client } from "@libsql/client";
import type { MergeRequestStatePort } from "../vcs/mr/types.js";
import { EPIC_BOARD_STATUS, epicStatusStatement } from "./epic-status-projection.js";
import { assertEpicTransition } from "./state-machine.js";

export type EpicCompletionOutcome =
  | { epicId: string; kind: "done" }
  | { epicId: string; kind: "awaiting_merge" }
  | { epicId: string; kind: "awaiting_acceptance" }
  | { epicId: string; kind: "unreadable"; reason: string };

/**
 * Closes an Epic once its review request has landed. Finishing is decided by
 * code, not reported by an agent: the merge is read from the hosting platform,
 * and the human side comes from where the design puts it — an Epic that
 * belongs to a requirement is accepted scenario by scenario on the requirement
 * page, while a standalone Epic is accepted by dragging it to the finished
 * column of the board.
 */
export class EpicCompletion {
  constructor(
    private readonly client: Client,
    private readonly mergeRequests: MergeRequestStatePort,
    private readonly now: () => number = Date.now,
  ) {}

  async tick(): Promise<EpicCompletionOutcome[]> {
    const rows = (await this.client.execute(
      `SELECT id, mr_url, requirement_id, notion_status_shadow FROM epics
        WHERE state = 'EPIC_ACCEPT' AND mr_url IS NOT NULL ORDER BY id`,
    )).rows;
    const outcomes: EpicCompletionOutcome[] = [];
    for (const row of rows) {
      const epicId = String(row.id);
      let merged: boolean;
      try {
        merged = await this.mergeRequests.isMerged(String(row.mr_url));
      } catch (error) {
        outcomes.push({ epicId, kind: "unreadable", reason: (error as Error).message });
        continue;
      }
      if (!merged) {
        outcomes.push({ epicId, kind: "awaiting_merge" });
        continue;
      }
      const standalone = row.requirement_id === null;
      if (standalone && row.notion_status_shadow !== EPIC_BOARD_STATUS.done) {
        outcomes.push({ epicId, kind: "awaiting_acceptance" });
        continue;
      }
      assertEpicTransition("EPIC_ACCEPT", "DONE");
      const time = this.now();
      const result = await this.client.batch([
        {
          sql: "UPDATE epics SET state = 'DONE', updated_at = ? WHERE id = ? AND state = 'EPIC_ACCEPT'",
          args: [time, epicId],
        },
        epicStatusStatement(epicId, EPIC_BOARD_STATUS.done, time, "DONE"),
      ], "write");
      if (result[0]?.rowsAffected === 1) outcomes.push({ epicId, kind: "done" });
    }
    return outcomes;
  }
}
