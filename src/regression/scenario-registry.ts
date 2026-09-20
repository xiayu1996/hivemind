import type { Client } from "@libsql/client";
import { LAYER_OWNER, type TestLayer } from "../pipeline/dod.js";

export type ScenarioPool = "epic" | "main";

/** Whether the stored layer list names one a browser settles. Unparsable text
 * is read as "unknown", which keeps the scenario in the pool. */
function hasScreenLayer(layers: string): boolean {
  try {
    const parsed: unknown = JSON.parse(layers);
    if (!Array.isArray(parsed)) return true;
    return parsed.some((item) => LAYER_OWNER[item as TestLayer] === "verify");
  } catch {
    // Not the JSON array a frozen DoD writes; nothing can be concluded from it,
    // and dropping a scenario on a parse failure would silently shrink the pool.
    return true;
  }
}

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
    const specs = (await this.client.execute({
      sql: "SELECT spec_id, layers FROM story_specs WHERE story_id = ? ORDER BY seq",
      args: [storyId],
    })).rows;
    // Only what a browser settles. The sweep is the screen lane: it opens the
    // application and judges what is on it, so a scenario proved by tests alone
    // gives it nothing to look at, and asking anyway fails the scenario every
    // cycle and raises a regression card nobody can close.
    // S-R237511MB-02-access was moved to `integration` for exactly that reason
    // -- no browser on this host can be on a disallowed network -- and the next
    // delivery put it straight back in the pool (2026-09-20).
    // A DoD frozen before layers were recorded says nothing either way, so it
    // keeps the behaviour it already had.
    const scenarios = specs
      .filter((spec) => spec.layers === null || hasScreenLayer(String(spec.layers)))
      .map((spec) => String(spec.spec_id));
    // Registration reconciles rather than only inserts: a scenario that has
    // since moved off the screen lane has to leave the pool, or the sweep keeps
    // failing what nothing will ever fix.
    await this.client.execute(scenarios.length === 0
      ? { sql: "DELETE FROM scenario_registry WHERE story_id = ?", args: [storyId] }
      : {
        sql: `DELETE FROM scenario_registry
               WHERE story_id = ? AND scenario_id NOT IN (${scenarios.map(() => "?").join(", ")})`,
        args: [storyId, ...scenarios],
      });
    if (scenarios.length === 0) return 0;

    const time = this.now();
    // A Story that belongs to an Epic delivers onto that Epic's integration
    // branch, so being delivered says nothing about main. Only a standalone
    // Story delivers onto the target branch directly.
    const standalone = row.epic_id === null;
    const pool: ScenarioPool = standalone && String(row.state) === "DELIVERED" ? "main" : "epic";
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

  /**
   * A standalone Story's scenarios become everyone's problem once it is
   * delivered, because it delivered onto the target branch.
   *
   * A Story that belongs to an Epic is refused here rather than quietly
   * ignored: it delivers onto the Epic's integration branch, and promoting it
   * then left the main pool claiming to cover twenty-six scenarios whose code
   * main did not have. Those are promoted by EpicCompletion when the platform
   * confirms the Epic merged.
   */
  async promoteToMain(storyId: string): Promise<void> {
    const row = (await this.client.execute({
      sql: "SELECT epic_id FROM stories WHERE id = ?",
      args: [storyId],
    })).rows[0];
    if (!row) throw new Error(`Story does not exist: ${storyId}`);
    if (row.epic_id !== null) {
      throw new Error(`Story ${storyId} belongs to Epic ${String(row.epic_id)}: its scenarios enter the main pool when that Epic merges`);
    }
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

  /**
   * The scenarios a sweep may run, optionally narrowed to one repository. A
   * sweep runs in a checkout, and a scenario from another repository cannot be
   * run there, so the caller that serves several repositories has to ask per
   * repository.
   *
   * Only a delivered Story's scenarios are swept. A Story is registered the
   * moment its Definition of Done exists, which is long before its code is on
   * the branch a sweep checks out, so until it merges its scenarios cannot
   * pass. They also cannot age: a failure never sets last_verified_at, so they
   * stay at the head of this queue and are swept again every idle cycle,
   * crowding out the scenarios that can say something. Three such sweeps meet
   * `regression.minFailures` with one identical signature and raise a
   * regression card against behaviour that was never built -- which then holds
   * its own Epic's gate shut and asks a person to look at it.
   */
  async pool(pool: ScenarioPool, repo?: string): Promise<RegisteredScenario[]> {
    const rows = (await this.client.execute(repo === undefined ? {
      sql: `SELECT r.scenario_id, r.story_id, r.epic_id, r.pool, r.last_verified_at
              FROM scenario_registry r JOIN stories s ON s.id = r.story_id
             WHERE r.pool = ? AND s.state = 'DELIVERED'
             ORDER BY r.last_verified_at IS NOT NULL, r.last_verified_at, r.scenario_id`,
      args: [pool],
    } : {
      sql: `SELECT r.scenario_id, r.story_id, r.epic_id, r.pool, r.last_verified_at
              FROM scenario_registry r JOIN stories s ON s.id = r.story_id
             WHERE r.pool = ? AND s.repo = ? AND s.state = 'DELIVERED'
             ORDER BY r.last_verified_at IS NOT NULL, r.last_verified_at, r.scenario_id`,
      args: [pool, repo],
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
