import type { Client } from "@libsql/client";
import { attributeRegression, type Attribution } from "./attribution.js";
import { storyTransitionStatement } from "../orchestrator/state-machine.js";
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
  /** Whether the scenario fails at this revision, or "unknown" when the
   * revision could not be judged at all -- an application that does not start
   * there says nothing about the break. */
  (revision: string, scenarioId: string): Promise<boolean | "unknown">;
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
  // A revision is a sha or there is no sequence. An empty one reaches git as
  // `checkout --detach ''`, which is a fatal pathspec error that kills the
  // sweep for the whole Epic, so the absence is expressed once here rather
  // than guarded at each place a revision is used.
  const base = rows.length > 0 ? String(rows[0]!.base_revision) : "";
  if (base === "" || steps.some((step) => step.revision === "")) return { base: "", steps: [] };
  return { base, steps };
}

/**
 * The Story a scenario was registered under, whether or not it is still in the
 * pipeline. Registration is a promise, so it names an owner with certainty
 * where a bisect can only guess.
 */
async function registeredOwner(client: Client, scenarioId: string): Promise<string | null> {
  const rows = (await client.execute({
    sql: "SELECT story_id FROM scenario_registry WHERE scenario_id = ?",
    args: [scenarioId],
  })).rows;
  return rows.length === 1 ? String(rows[0]!.story_id) : null;
}

/**
 * Bisects a raised regression card down to the Story that introduced it and
 * reopens that Story, rather than reopening whatever merged last.
 *
 * A break that predates the sequence introduced nothing, and one the bisect
 * could not follow -- because some revision could not be judged at all -- names
 * nobody either. The scenario still has an owner in both cases: the Story that
 * registered it and has never made it pass. Leaving those cards unattributed
 * left them open with no actor able to close them, which holds their Epic at
 * the review gate forever while every sweep pays to fail again. Reopening the
 * registered owner is not a guess, and `retry.maxRegressionReopens` bounds how
 * often it may happen.
 *
 * A failure that will not reproduce stays unattributed on purpose: there is
 * nothing to fix, and the card closes on its own the next time the scenario
 * runs green.
 */
export async function attributeCard(
  client: Client,
  store: RegressionStore,
  card: { scenarioId: string; failureSignature: string },
  sequence: AttributionSequence,
  probe: RevisionProbe,
  now: () => number = Date.now,
): Promise<Attribution> {
  // Nothing has landed on this Epic head, so there is no revision to probe.
  // Probing anyway handed git the empty string that stands for "no base" and
  // killed the sweep for the whole Epic: `git checkout --detach ''` is a fatal
  // pathspec error, not a checkout.
  const attribution: Attribution = sequence.base === ""
    ? { kind: "pre_existing", probes: 0 }
    : await attributeRegression(
      sequence.steps.map((step) => step.storyId),
      async (index) => probe(
        index === 0 ? sequence.base : sequence.steps[index - 1]!.revision,
        card.scenarioId,
      ),
    );
  if (attribution.kind === "not_reproduced") return attribution;
  const owner = attribution.kind === "introduced"
    ? attribution.item
    : await registeredOwner(client, card.scenarioId);
  if (owner === null) return attribution;

  await store.attribute(card.scenarioId, card.failureSignature, owner);
  const time = now();
  // Priority 0 puts it ahead of every ordinary card: a known regression on the
  // Epic head blocks everything else landing there.
  const [update] = await client.batch([
    // Reopened into SPECIFY, not straight into the fix: the reproduction test
    // is written and proved red before anything may change the code it exists
    // to prove. `phase` stays REGRESSION_FIX so the worker knows this SPECIFY
    // is the narrow one and where it leads.
    storyTransitionStatement({
      cardId: owner, from: "DELIVERED", to: "SPECIFY", at: time,
      set: { phase: "REGRESSION_FIX", priority: 0 },
    }),
    {
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                    ?, 'REGRESSION_FIX', 'regression.attributed', ?, ?)`,
      args: [
        `regression:${card.scenarioId}`,
        `regression:${card.scenarioId}`,
        owner,
        time,
        JSON.stringify({
          scenarioId: card.scenarioId,
          failureSignature: card.failureSignature,
          origin: attribution.kind,
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
