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

  const unproven = (await client.execute({
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
