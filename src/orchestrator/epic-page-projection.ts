import type { Client, InStatement } from "@libsql/client";
import { payloadHash } from "../notion/outbox.js";
import text from "./epic-page-text.json" with { type: "json" };
import { BOARD_STATUS_FOR_STATE, type EpicBoardStatus } from "./epic-status-projection.js";
import type { EpicState } from "./state-machine.js";

export const SYNC_EPIC_PAGE = "sync_epic_page";

export interface EpicPageStory {
  id: string;
  title: string;
  state: string;
  stopReason: string | null;
  mrUrl: string | null;
}

/**
 * Everything the Epic page shows about where the Epic stands. Deterministic
 * for a given database state, so the outbox hash dedupes an unchanged page.
 */
export interface EpicPagePayload {
  epicId: string;
  status: EpicBoardStatus;
  mrUrl: string | null;
  targetBranch: string;
  integrationBranch: string | null;
  blockedReason: string | null;
  stories: EpicPageStory[];
}

export async function epicPagePayload(client: Client, epicId: string, targetBranch = "main"): Promise<EpicPagePayload | null> {
  const epic = (await client.execute({
    sql: "SELECT state, mr_url, integration_branch FROM epics WHERE id = ?",
    args: [epicId],
  })).rows[0];
  if (!epic) return null;
  const status = BOARD_STATUS_FOR_STATE[String(epic.state) as EpicState];
  if (!status) return null;
  const stories = (await client.execute({
    sql: `SELECT id, title, state, stop_reason, mr_url FROM stories WHERE epic_id = ? ORDER BY created_at, id`,
    args: [epicId],
  })).rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    state: String(row.state),
    stopReason: row.stop_reason === null ? null : String(row.stop_reason),
    mrUrl: row.mr_url === null ? null : String(row.mr_url),
  }));
  let blockedReason: string | null = null;
  if (epic.state === "BLOCKED") {
    const transition = (await client.execute({
      sql: "SELECT data FROM event_log WHERE run_id = ? AND type = 'epic.transition' ORDER BY seq DESC LIMIT 1",
      args: [`epic:${epicId}`],
    })).rows[0];
    const data = transition ? JSON.parse(String(transition.data)) as { to?: string; reason?: string } : null;
    blockedReason = data?.to === "BLOCKED" && data.reason ? data.reason : null;
  }
  return {
    epicId,
    status,
    mrUrl: epic.mr_url === null ? null : String(epic.mr_url),
    targetBranch,
    integrationBranch: epic.integration_branch === null ? null : String(epic.integration_branch),
    blockedReason,
    stories,
  };
}

export function epicPageStatement(payload: EpicPagePayload, time: number): InStatement {
  const encoded = payloadHash(payload);
  return {
    sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
          VALUES (?, 2, ?, ?, ?, ?, ?)
          ON CONFLICT(target, payload_hash) DO NOTHING`,
    args: [payload.epicId, SYNC_EPIC_PAGE, `epic-page:${payload.epicId}`, encoded.json, encoded.hash, time],
  };
}

/** Queues every live Epic's page; an unchanged page hashes to a row that already exists. */
export async function enqueueEpicPages(client: Client, targetBranch = "main", now: () => number = Date.now): Promise<number> {
  const epics = (await client.execute("SELECT id FROM epics WHERE state <> 'FAILED' ORDER BY id")).rows;
  let queued = 0;
  for (const row of epics) {
    const payload = await epicPagePayload(client, String(row.id), targetBranch);
    if (!payload) continue;
    const result = await client.execute(epicPageStatement(payload, now()));
    queued += result.rowsAffected;
  }
  return queued;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

/** The lines a person reads under the progress heading, in order. */
export function renderEpicProgress(payload: EpicPagePayload): { lead: string[]; stories: string[] } {
  const lead: string[] = [];
  if (payload.mrUrl) {
    lead.push(fill(text.reviewRequest, { url: payload.mrUrl, target: payload.targetBranch }));
  } else if (payload.integrationBranch) {
    lead.push(fill(text.integrationBranch, { branch: payload.integrationBranch }));
  }
  // The reason kept in the event log is written for an operator and names the
  // stop by its enum. When the block is Stories waiting on an answer, the page
  // says so in the reader's words and the Story lines carry the detail.
  const waiting = payload.stories.filter((story) => story.state === "NEEDS_INPUT").map((story) => story.id);
  if (waiting.length > 0) {
    lead.push(fill(text.blockedWaiting, { stories: waiting.join("、") }));
  } else if (payload.blockedReason) {
    lead.push(fill(text.blocked, { reason: payload.blockedReason }));
  }
  const states: Record<string, string> = text.storyStates;
  const stops: Record<string, string> = text.stopReasons;
  const stories = payload.stories.map((story) => {
    let line = fill(text.storyLine, { id: story.id, title: story.title, state: states[story.state] ?? story.state });
    if (story.stopReason) line += fill(text.storyStop, { reason: stops[story.stopReason] ?? story.stopReason });
    if (story.mrUrl) line += fill(text.storyMr, { url: story.mrUrl });
    return line;
  });
  return { lead, stories };
}
