import type { Client } from "@libsql/client";

/**
 * A check that fails on an Epic's own head, with the Story that discovered it.
 *
 * It is recorded against the Epic rather than the Story because no work on the
 * Story changes it: S-AGENTRULES-01 spent two rounds rewriting code against a
 * test failure that was already on the branch before it arrived.
 */
export interface EpicHeadFailure {
  epicId: string;
  /** The Story whose merge found it; it stays in MERGE and lands once the head is green. */
  storyId: string;
  /** The head the checks were run on. A moved head is a reason to look again. */
  headSha: string;
  check: string;
  failures: readonly string[];
  ts: number;
}

/** The event id is carried so a recovery can be matched to the failure it clears. */
interface HeadEvent {
  id: number;
  type: string;
  ts: number;
  data: Record<string, unknown>;
}

async function headEvents(client: Client): Promise<HeadEvent[]> {
  const rows = (await client.execute(
    `SELECT id, type, ts, data, run_id FROM event_log
      WHERE type IN ('epic.head_failing', 'epic.head_recovered')
      ORDER BY id`,
  )).rows;
  return rows.map((row) => ({
    id: Number(row.id),
    type: String(row.type),
    ts: Number(row.ts),
    data: { epicId: String(row.run_id).replace(/^epic:/, ""), ...JSON.parse(String(row.data)) as Record<string, unknown> },
  }));
}

/**
 * The Epics whose own head is failing a check right now: the latest
 * `epic.head_failing` with no `epic.head_recovered` after it.
 */
export async function unrecoveredHeadFailures(client: Client): Promise<Map<string, EpicHeadFailure>> {
  const latest = new Map<string, HeadEvent>();
  for (const event of await headEvents(client)) {
    latest.set(String(event.data.epicId), event);
  }
  const failures = new Map<string, EpicHeadFailure>();
  for (const [epicId, event] of latest) {
    if (event.type !== "epic.head_failing") continue;
    failures.set(epicId, {
      epicId,
      storyId: String(event.data.storyId ?? ""),
      headSha: String(event.data.headSha ?? ""),
      check: String(event.data.check ?? ""),
      failures: Array.isArray(event.data.failures) ? event.data.failures.map(String) : [],
      ts: event.ts,
    });
  }
  return failures;
}
