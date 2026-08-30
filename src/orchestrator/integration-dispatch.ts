import type { Client } from "@libsql/client";

export type StartClaim =
  | { kind: "blocked"; waitingFor: readonly string[] }
  | { kind: "started"; integrationBranch: string };

function dependencies(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("Story dependencies are not JSON text");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
    throw new Error("Story dependencies are not an array of ids");
  }
  return [...new Set(parsed)].toSorted();
}

/** Claims a Story only when its declared dependencies are already in the Epic head. */
export class IntegrationDispatchStore {
  constructor(private readonly client: Client) {}

  async claimStart(storyId: string, branch: string): Promise<StartClaim> {
    const row = (await this.client.execute({
      sql: `SELECT s.epic_id, s.state, s.branch, s.depends_on, e.state AS epic_state
            FROM stories s JOIN epics e ON e.id = s.epic_id WHERE s.id = ?`,
      args: [storyId],
    })).rows[0];
    if (!row) throw new Error(`Story ${storyId} does not belong to an Epic`);
    if (row.epic_state !== "EXECUTING") throw new Error("Epic is not executing");
    if (row.state !== "QUEUED") throw new Error(`Story ${storyId} is not queued`);
    if (row.branch !== null) throw new Error(`Story ${storyId} already has a branch`);
    const dependsOn = dependencies(row.depends_on);
    const waitingFor: string[] = [];
    for (const dependency of dependsOn) {
      const dependencyRow = (await this.client.execute({
        sql: "SELECT state, epic_id FROM stories WHERE id = ?",
        args: [dependency],
      })).rows[0];
      if (!dependencyRow || dependencyRow.epic_id !== row.epic_id || dependencyRow.state !== "DELIVERED") {
        waitingFor.push(dependency);
      }
    }
    if (waitingFor.length > 0) return { kind: "blocked", waitingFor: waitingFor.toSorted() };
    const targetBranch = `epic/${String(row.epic_id)}`;
    const update = await this.client.execute({
      sql: `UPDATE stories SET branch = ?, target_branch = ?, updated_at = updated_at
            WHERE id = ? AND state = 'QUEUED' AND branch IS NULL`,
      args: [branch, targetBranch, storyId],
    });
    if (update.rowsAffected !== 1) throw new Error(`Story start lost a race: ${storyId}`);
    return { kind: "started", integrationBranch: targetBranch };
  }
}
