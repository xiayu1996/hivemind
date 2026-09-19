import type { Client } from "@libsql/client";

/**
 * Which repository a sweep is sweeping.
 *
 * The sweep's settings are per-repo -- how the repository starts its
 * application, which hosts the browser may reach -- and a store with no
 * repository answers those keys with a value nobody configured. The answer is
 * a fact in the database rather than an argument the caller must remember,
 * because the caller is a long-lived daemon and its children are spawned from
 * whatever code is on disk: a new required flag is a deployment step, while a
 * derived answer is correct the moment the child is replaced.
 */
export async function sweepRepository(
  client: Client,
  input: { epicId?: string | null; scenarioIds: readonly string[] },
): Promise<string> {
  if (input.epicId) {
    const repo = (await client.execute({
      sql: "SELECT repo FROM epics WHERE id = ?",
      args: [input.epicId],
    })).rows[0]?.repo;
    if (typeof repo === "string" && repo !== "") return repo;
    throw new Error(`Epic ${input.epicId} names no repository, so the sweep cannot read its settings`);
  }
  if (input.scenarioIds.length === 0) throw new Error("a sweep with no scenarios has no repository");
  const placeholders = input.scenarioIds.map(() => "?").join(", ");
  const repos = (await client.execute({
    sql: `SELECT DISTINCT s.repo AS repo
            FROM scenario_registry r JOIN stories s ON s.id = r.story_id
           WHERE r.scenario_id IN (${placeholders}) AND s.repo IS NOT NULL AND s.repo <> ''`,
    args: [...input.scenarioIds],
  })).rows.map((row) => String(row.repo));
  // Two repositories in one sweep would be judged in one worktree at one
  // revision, so the ambiguity is the caller's bug rather than something to
  // pick a winner from.
  if (repos.length === 1) return repos[0]!;
  if (repos.length === 0) throw new Error("none of the swept scenarios belongs to a repository");
  throw new Error(`the swept scenarios span ${repos.toSorted().join(", ")}, which one sweep cannot judge`);
}
