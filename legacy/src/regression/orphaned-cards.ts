import type { Client } from "@libsql/client";

/**
 * Open regression cards on scenarios that have left the sweep pool.
 *
 * A regression card has exactly two doors out: the sweep records a passing run
 * for the scenario and `clearCards` closes it, or the owning Story lands a fix
 * and `resolveRegressionCard` closes it. The sweep only ever looks at what
 * `scenario_registry` holds, and `ScenarioRegistry.registerStory` reconciles
 * that table -- a scenario whose spec moved off the screen lane is deleted from
 * it. A card raised before that move therefore loses its first door for good,
 * and it loses the second one too as soon as its owner stops: an owner parked
 * in NEEDS_INPUT is dispatched to nobody, and its reopen budget only resets
 * when a person releases it.
 *
 * S-R237511MB-02-access sat in exactly that position for 44 hours. Its premise
 * is a device outside the allowed networks, which no browser on the host can
 * be, so the scenario was moved to the code lane and left the pool; the card it
 * had already raised then drove the Story into `retry_limit_exceeded` twice,
 * and both times the stop said only that the loop had reopened it twice. The
 * situation a person has to act on -- no automatic path can ever close this
 * card -- was nowhere on the page.
 *
 * This is a report, never a veto. The predicate is deterministic and says
 * truthfully that a card is orphaned; it cannot say whether the card *should*
 * be closed, because that means reading whether the proof the scenario moved to
 * actually holds. Closing it automatically would be worse than saying nothing:
 * the layer that decides pool membership is written by the Story itself, so a
 * card could close its own regression by demoting the scenario it keeps failing
 * -- no fix, one field. Hence the opposite default: name it, and leave the
 * judgement with a person.
 */

export interface OrphanedRegressionCard {
  scenarioId: string;
  failureSignature: string;
  /** Null for a card the sweep raised before any Story claimed it. */
  attributedStory: string | null;
  /** What the owner's spec now says proves this scenario, verbatim from
   * `story_specs.layers`; null when its Definition of Done predates layers. */
  layers: string | null;
  createdAt: number;
}

const SELECT_ORPHANS = `
  SELECT c.scenario_id, c.failure_signature, c.attributed_story, c.created_at,
         (SELECT p.layers FROM story_specs p WHERE p.spec_id = c.scenario_id LIMIT 1) AS layers
    FROM regression_cards c
   WHERE c.resolved_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM scenario_registry r WHERE r.scenario_id = c.scenario_id
     )`;

function toOrphan(row: Record<string, unknown>): OrphanedRegressionCard {
  return {
    scenarioId: String(row.scenario_id),
    failureSignature: String(row.failure_signature),
    attributedStory: row.attributed_story === null ? null : String(row.attributed_story),
    layers: row.layers === null || row.layers === undefined ? null : String(row.layers),
    createdAt: Number(row.created_at),
  };
}

/** Which orphans to read: all of them, one Epic's, or one Story's. */
export interface OrphanScope {
  epicId?: string;
  storyId?: string;
}

/**
 * Every orphaned card, or only those belonging to one Epic or one Story.
 *
 * An unattributed card belongs to no Epic and no Story, so a scoped read
 * leaves it out while the unscoped read keeps it: an orphan with no owner is
 * the one case where nothing at all would otherwise mention it.
 */
export async function readOrphanedCards(
  client: Client,
  scope: OrphanScope = {},
): Promise<OrphanedRegressionCard[]> {
  const conditions: string[] = [];
  const args: string[] = [];
  if (scope.epicId !== undefined) {
    conditions.push("EXISTS (SELECT 1 FROM stories s WHERE s.id = c.attributed_story AND s.epic_id = ?)");
    args.push(scope.epicId);
  }
  if (scope.storyId !== undefined) {
    conditions.push("c.attributed_story = ?");
    args.push(scope.storyId);
  }
  const rows = (await client.execute({
    sql: `${SELECT_ORPHANS}${conditions.map((condition) => `\n     AND ${condition}`).join("")}
   ORDER BY c.created_at, c.scenario_id`,
    args,
  })).rows;
  return rows.map(toOrphan);
}

/**
 * One sentence per card, naming the two things a person needs: that no sweep
 * will ever close it, and the decision that is theirs to make.
 */
export function describeOrphanedCard(card: OrphanedRegressionCard): string {
  const owner = card.attributedStory ?? "no Story";
  const proof = card.layers === null
    ? "its Definition of Done records no layers"
    : `its spec now says ${card.layers}`;
  return `${card.scenarioId} (${owner}) carries an open regression card but has left the sweep pool: `
    + `${proof}, so no sweep will ever run it and no sweep can close the card. `
    + `Confirm the proof it moved to holds and close the card, or move the scenario back onto the screen lane.`;
}
