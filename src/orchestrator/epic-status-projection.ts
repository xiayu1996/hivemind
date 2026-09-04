import type { InStatement } from "@libsql/client";
import { payloadHash } from "../notion/outbox.js";
import schema from "../notion/notion-schema.json" with { type: "json" };
import type { EpicState } from "./state-machine.js";

/**
 * The board's Epic status column, named by what each option means to the
 * person reading it. The orchestrator owns this column except for the one
 * drag a human makes to approve a plan and the one they make to accept a
 * finished Epic; both are read back through the shadow the delivery keeps.
 */
export const EPIC_BOARD_STATUS = {
  waiting: schema.options.epicStatus[0]!,
  planned: schema.options.epicStatus[1]!,
  executing: schema.options.epicStatus[2]!,
  done: schema.options.epicStatus[3]!,
} as const;

export type EpicBoardStatus = (typeof EPIC_BOARD_STATUS)[keyof typeof EPIC_BOARD_STATUS];

export const SYNC_EPIC_STATUS = "sync_epic_status";

/**
 * The outbox row that carries an Epic's status to the board, for use inside
 * the same batch as the state change it reports. `whenState` ties the row to
 * the transition: a conditional update that affected nothing must not still
 * announce the state it failed to reach. The time is part of the payload
 * because a status can legitimately recur (a revised plan is presented
 * again) and the delivery is idempotent on what the board already shows.
 */
export function epicStatusStatement(
  epicId: string,
  status: EpicBoardStatus,
  time: number,
  whenState?: EpicState,
): InStatement {
  const encoded = payloadHash({ epicId, status, at: time });
  const values = [epicId, SYNC_EPIC_STATUS, `epic-status:${epicId}`, encoded.json, encoded.hash, time];
  if (whenState === undefined) {
    return {
      sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
            VALUES (?, 1, ?, ?, ?, ?, ?)
            ON CONFLICT(target, payload_hash) DO NOTHING`,
      args: values,
    };
  }
  return {
    sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
          SELECT ?, 1, ?, ?, ?, ?, ? FROM epics WHERE id = ? AND state = ?
          ON CONFLICT(target, payload_hash) DO NOTHING`,
    args: [...values, epicId, whenState],
  };
}
