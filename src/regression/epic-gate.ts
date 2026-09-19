import type { Client } from "@libsql/client";

export interface EpicRegressionGate {
  clean: boolean;
  reason?: string;
}

/**
 * Whether an Epic's review request may be opened.
 *
 * Two questions, and the second one is the reason this is not a card count.
 * "No open regression card" is only the absence of bad news: a registry whose
 * scenarios have never been run reports exactly the same thing as one that
 * swept clean, and on 2026-09-11 that is what E1ACTION looked like - six
 * delivered Stories, twenty-two registered scenarios, and zero rows in
 * regression_runs. So the gate also asks for the good news: every scenario
 * registered under the Epic has passed at the revision being proposed. A run
 * against an earlier head says the Epic used to integrate, which is not the
 * claim a review request makes.
 */
/**
 * The scenarios standing between an Epic and its review request: registered
 * under it with no passing run at the revision that request would propose.
 *
 * Asking a looser question ("has it ever passed?") let an Epic whose head had
 * moved drop out of this set: every scenario of S-R237511DT-02 had passed on
 * the previous head, so the Epic waited on an idle host that a 7x24 service
 * does not reliably produce. The sweep scheduler asks the wider
 * `scenariosAwaitingDelivery`, which adds the carded ones.
 */
export async function unprovenScenarios(
  client: Client,
  epicId: string,
  revision: string,
): Promise<string[]> {
  return (await client.execute({
    sql: `SELECT r.scenario_id
            FROM scenario_registry r
           WHERE r.epic_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM regression_runs u
                WHERE u.scenario_id = r.scenario_id
                  AND u.revision = ?
                  AND u.outcome = 'passed'
             )
           ORDER BY r.scenario_id`,
    args: [epicId, revision],
  })).rows.map((row) => String(row.scenario_id));
}

/**
 * Everything standing between an Epic and its review request: the unproven
 * scenarios, plus those carrying an open regression card.
 *
 * The card limb is here because a card closes on evidence -- a window of the
 * scenario that no longer fails -- and on a 7x24 host the only sweeps that
 * ever gather it are the ones the foreground asks for. Left out, an Epic whose
 * scenarios all pass at its head still waits on cards, and the sweeps that
 * would close them are the idle ones that never come.
 */
export async function scenariosAwaitingDelivery(
  client: Client,
  epicId: string,
  revision: string,
): Promise<string[]> {
  return (await client.execute({
    sql: `SELECT r.scenario_id
            FROM scenario_registry r
           WHERE r.epic_id = ?
             AND (NOT EXISTS (
                   SELECT 1 FROM regression_runs u
                    WHERE u.scenario_id = r.scenario_id
                      AND u.revision = ?
                      AND u.outcome = 'passed'
                 )
                 OR EXISTS (
                   SELECT 1 FROM regression_cards c
                    WHERE c.scenario_id = r.scenario_id AND c.resolved_at IS NULL
                 ))
           ORDER BY r.scenario_id`,
    args: [epicId, revision],
  })).rows.map((row) => String(row.scenario_id));
}

/** Epics in a repository whose Stories have all landed and which have not yet
 * opened a review request: the ones whose only remaining obstacle is evidence. */
export async function epicsAwaitingDelivery(client: Client, repo: string): Promise<string[]> {
  return (await client.execute({
    sql: `SELECT e.id FROM epics e
           WHERE e.state = 'EXECUTING' AND e.mr_url IS NULL AND e.repo = ?
             AND EXISTS (SELECT 1 FROM stories s WHERE s.epic_id = e.id)
             AND NOT EXISTS (SELECT 1 FROM stories s WHERE s.epic_id = e.id AND s.state <> 'DELIVERED')
           ORDER BY e.id`,
    args: [repo],
  })).rows.map((row) => String(row.id));
}

export async function epicRegressionClean(
  client: Client,
  epicId: string,
  revision: string,
): Promise<EpicRegressionGate> {
  if (revision.trim() === "") throw new Error("an Epic regression gate needs the revision it is judging");
  const open = (await client.execute({
    sql: `SELECT c.scenario_id, c.failure_signature
            FROM regression_cards c
            JOIN scenario_registry r ON r.scenario_id = c.scenario_id
           WHERE r.epic_id = ? AND c.resolved_at IS NULL
           ORDER BY c.scenario_id, c.failure_signature`,
    args: [epicId],
  })).rows;
  if (open.length > 0) {
    const scenarios = [...new Set(open.map((row) => String(row.scenario_id)))];
    return {
      clean: false,
      reason: `Epic ${epicId} has ${open.length} open regression card(s) on ${scenarios.join(", ")}`,
    };
  }

  const unproven = await unprovenScenarios(client, epicId, revision);
  if (unproven.length > 0) {
    return {
      clean: false,
      reason: `Epic ${epicId} has ${unproven.length} scenario(s) with no passing run at ${revision.slice(0, 12)}: ${unproven.join(", ")}`,
    };
  }

  // An Epic that registered nothing has proven nothing. Whether that is a
  // decomposition that declared no scenarios or a registry that was never
  // written, it is a question for a person, not a pass.
  const registered = Number((await client.execute({
    sql: "SELECT COUNT(*) AS count FROM scenario_registry WHERE epic_id = ?",
    args: [epicId],
  })).rows[0]?.count ?? 0);
  if (registered === 0) {
    return { clean: false, reason: `Epic ${epicId} has no registered scenarios, so nothing has been verified on it` };
  }
  return { clean: true };
}
