import type { Client } from "@libsql/client";

export type ScenarioPool = "epic" | "main";

export interface RegisteredScenario {
  scenarioId: string;
  storyId: string;
  epicId: string | null;
  pool: ScenarioPool;
  lastVerifiedAt: number | null;
}

/**
 * Which scenarios exist and who has to keep them passing. A scenario belongs to
 * the Epic pool while its Story is still landing, and moves to the main pool
 * once the Story is delivered: the two pools differ in what they run against,
 * not in what they mean.
 */
export class ScenarioRegistry {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  /** Registers everything a Story's frozen Definition of Done declares. Safe to
   * repeat: re-freezing the same DoD must not reset when a scenario was last
   * verified. */
  async registerStory(storyId: string): Promise<number> {
    const row = (await this.client.execute({
      sql: "SELECT epic_id, state FROM stories WHERE id = ?",
      args: [storyId],
    })).rows[0];
    if (!row) throw new Error(`Story does not exist: ${storyId}`);
    const scenarios = (await this.client.execute({
      sql: "SELECT spec_id FROM story_specs WHERE story_id = ? ORDER BY seq",
      args: [storyId],
    })).rows.map((spec) => String(spec.spec_id));
    if (scenarios.length === 0) return 0;

    const time = this.now();
    const pool: ScenarioPool = String(row.state) === "DELIVERED" ? "main" : "epic";
    await this.client.batch(scenarios.map((scenarioId) => ({
      sql: `INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(scenario_id) DO UPDATE SET
              story_id = excluded.story_id,
              epic_id = excluded.epic_id,
              updated_at = excluded.updated_at`,
      args: [scenarioId, storyId, row.epic_id === null ? null : String(row.epic_id), pool, time, time],
    })), "write");
    return scenarios.length;
  }

  /** A delivered Story's scenarios are everyone's problem from now on. */
  async promoteToMain(storyId: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE scenario_registry SET pool = 'main', updated_at = ? WHERE story_id = ? AND pool <> 'main'",
      args: [this.now(), storyId],
    });
  }

  async markVerified(scenarioIds: readonly string[], at = this.now()): Promise<void> {
    if (scenarioIds.length === 0) return;
    await this.client.batch(scenarioIds.map((scenarioId) => ({
      sql: "UPDATE scenario_registry SET last_verified_at = ?, updated_at = ? WHERE scenario_id = ?",
      args: [at, at, scenarioId],
    })), "write");
  }

  async pool(pool: ScenarioPool): Promise<RegisteredScenario[]> {
    const rows = (await this.client.execute({
      sql: `SELECT scenario_id, story_id, epic_id, pool, last_verified_at
              FROM scenario_registry WHERE pool = ?
             ORDER BY last_verified_at IS NOT NULL, last_verified_at, scenario_id`,
      args: [pool],
    })).rows;
    return rows.map((row) => ({
      scenarioId: String(row.scenario_id),
      storyId: String(row.story_id),
      epicId: row.epic_id === null ? null : String(row.epic_id),
      pool: String(row.pool) as ScenarioPool,
      lastVerifiedAt: typeof row.last_verified_at === "number" ? row.last_verified_at : null,
    }));
  }

  async forEpic(epicId: string): Promise<RegisteredScenario[]> {
    const rows = (await this.client.execute({
      sql: `SELECT scenario_id, story_id, epic_id, pool, last_verified_at
              FROM scenario_registry WHERE epic_id = ? ORDER BY scenario_id`,
      args: [epicId],
    })).rows;
    return rows.map((row) => ({
      scenarioId: String(row.scenario_id),
      storyId: String(row.story_id),
      epicId: row.epic_id === null ? null : String(row.epic_id),
      pool: String(row.pool) as ScenarioPool,
      lastVerifiedAt: typeof row.last_verified_at === "number" ? row.last_verified_at : null,
    }));
  }
}
