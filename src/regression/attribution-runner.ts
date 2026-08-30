import type { Client } from "@libsql/client";
import { attributeRegression, type Attribution } from "./attribution.js";
import type { RegressionStore } from "./store.js";

export interface IntegrationStep {
  storyId: string;
  /** The Epic head after this Story landed. Integration fast-forwards, so the
   * Story revision is the branch revision. */
  revision: string;
}

export interface AttributionSequence {
  /** The branch before anything in this sequence landed. */
  base: string;
  steps: readonly IntegrationStep[];
}

export interface RevisionProbe {
  /** Whether the scenario fails at this revision. */
  (revision: string, scenarioId: string): Promise<boolean>;
}

/**
 * The order Stories landed on an Epic head, with the revision each one produced.
 * Ordered by when the integration was recorded, which is the order the merges
 * actually happened in.
 */
export async function attributionSequence(client: Client, epicId: string): Promise<AttributionSequence> {
  const rows = (await client.execute({
    sql: `SELECT d.story_id, c.base_revision, c.story_revision
            FROM execution_dispatches d
            JOIN actual_footprint_captures c ON c.story_id = d.story_id
           WHERE d.epic_id = ? AND d.state = 'integrated'
           ORDER BY d.integrated_at, d.story_id`,
    args: [epicId],
  })).rows;
  const steps = rows.map((row) => ({
    storyId: String(row.story_id),
    revision: String(row.story_revision),
  }));
  return { base: rows.length > 0 ? String(rows[0]!.base_revision) : "", steps };
}

/**
 * Bisects a raised regression card down to the Story that introduced it and
 * reopens that Story, rather than reopening whatever merged last. A failure
 * that predates the sequence, or one that will not reproduce, is left
 * unattributed on purpose: naming the wrong Story costs a whole inner loop.
 */
export async function attributeCard(
  client: Client,
  store: RegressionStore,
  card: { scenarioId: string; failureSignature: string },
  sequence: AttributionSequence,
  probe: RevisionProbe,
  now: () => number = Date.now,
): Promise<Attribution> {
  const attribution = await attributeRegression(
    sequence.steps.map((step) => step.storyId),
    async (index) => probe(
      index === 0 ? sequence.base : sequence.steps[index - 1]!.revision,
      card.scenarioId,
    ),
  );
  if (attribution.kind !== "introduced") return attribution;

  await store.attribute(card.scenarioId, card.failureSignature, attribution.item);
  const time = now();
  // Priority 0 puts it ahead of every ordinary card: a known regression on the
  // Epic head blocks everything else landing there.
  const [update] = await client.batch([
    {
      sql: `UPDATE stories SET state = 'REGRESSION_FIX', phase = 'REGRESSION_FIX', priority = 0, updated_at = ?
             WHERE id = ? AND state = 'DELIVERED'`,
      args: [time, attribution.item],
    },
    {
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                    ?, 'REGRESSION_FIX', 'regression.attributed', ?, ?)`,
      args: [
        `regression:${card.scenarioId}`,
        `regression:${card.scenarioId}`,
        attribution.item,
        time,
        JSON.stringify({
          scenarioId: card.scenarioId,
          failureSignature: card.failureSignature,
          probes: attribution.probes,
        }),
      ],
    },
  ], "write");
  if (update?.rowsAffected !== 1) {
    // The Story is already back in the pipeline; the card keeps the attribution
    // and the running card will carry the fix.
    return attribution;
  }
  return attribution;
}
