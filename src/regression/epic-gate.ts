import type { Client } from "@libsql/client";

export interface EpicRegressionGate {
  clean: boolean;
  reason?: string;
}

/**
 * An Epic's review request is held while any scenario registered under it
 * carries an open regression card. A card is open until resolved_at is set;
 * attribution alone does not close it, because knowing which Story broke a
 * scenario is not the same as the scenario passing again.
 */
export async function epicRegressionClean(client: Client, epicId: string): Promise<EpicRegressionGate> {
  const rows = (await client.execute({
    sql: `SELECT c.scenario_id, c.failure_signature
            FROM regression_cards c
            JOIN scenario_registry r ON r.scenario_id = c.scenario_id
           WHERE r.epic_id = ? AND c.resolved_at IS NULL
           ORDER BY c.scenario_id, c.failure_signature`,
    args: [epicId],
  })).rows;
  if (rows.length === 0) return { clean: true };
  const scenarios = [...new Set(rows.map((row) => String(row.scenario_id)))];
  return {
    clean: false,
    reason: `Epic ${epicId} has ${rows.length} open regression card(s) on ${scenarios.join(", ")}`,
  };
}
