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
 * The caller only asks about cards whose scenario failed in the sweep it is
 * running, at this very revision, so a probe that passes at the tip is not
 * news that the break is gone -- it contradicts the evidence the card is made
 * of, and the bisect standing on it cannot name anyone either. A card whose
 * scenario really has gone green is closed by the sweep itself, without anyone
 * being asked to fix it.
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
  // Every kind but "introduced" names nobody, and each of them is asked about
  // a scenario the sweep just failed at this very revision: the break predates
  // the sequence, or a revision could not be judged, or the tip probe passed
  // and so contradicts the evidence this card is made of. None of the three is
  // grounds to blame a Story in the sequence, and none of them means there is
  // nothing to fix -- so the scenario goes to the Story that registered it.
  const owner = attribution.kind === "introduced"
    ? attribution.item
    : await registeredOwner(client, card.scenarioId);
  if (owner === null) return attribution;

  await store.attribute(card.scenarioId, card.failureSignature, owner);
  await reopenOwner(client, card, owner, attribution.kind, attribution.probes, now);
  return attribution;
}

/**
 * Sends a card's Story back to work on it.
 *
 * Separate from the bisect because a card that already names its owner has
 * nothing left to decide: the sweep failed the scenario again at this
 * revision, the owner is settled, and the only question is whether that Story
 * is idle. A delivered owner with an open card against it is the state nothing
 * used to look at -- S-R237511OV-01 answered its cards once, was stopped
 * mid-lane and released as an ordinary round, delivered without them, and then
 * held its Epic at the review gate for seven hours while every sweep paid to
 * fail the same two scenarios again (2026-09-19). The reopen budget bounds how
 * often this may happen, and the worker stops the card for a person when it
 * runs out.
 *
 * Returns false when the Story was no longer delivered, which means it is
 * already back in the pipeline and will carry the fix.
 */
export async function reopenOwner(
  client: Client,
  card: { scenarioId: string; failureSignature: string },
  owner: string,
  origin: string,
  probes: number,
  now: () => number = Date.now,
): Promise<boolean> {
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
          origin,
          probes,
        }),
      ],
    },
  ], "write");
  return update?.rowsAffected === 1;
}
