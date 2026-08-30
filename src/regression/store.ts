import type { Client } from "@libsql/client";
import type { ConfigStore } from "../config/store.js";
import type { ScenarioPool } from "./scenario-registry.js";
import {
  failureSignature,
  judgeRegression,
  type RegressionJudgement,
  type RegressionObservation,
  type RegressionPolicy,
} from "./verdict.js";

export interface RegressionRecord {
  scenarioId: string;
  pool: ScenarioPool;
  revision: string;
  outcome: "passed" | "failed";
  /** The failure text; only read when the outcome is a failure. */
  output?: string;
}

export interface RegressionResult {
  judgement: RegressionJudgement;
  /** True only the first time this exact break is seen for this scenario. */
  cardRaised: boolean;
}

export async function regressionPolicy(config: ConfigStore): Promise<RegressionPolicy> {
  await config.reload();
  return {
    windowSize: config.get("regression.windowSize"),
    failureRateThreshold: config.get("regression.failureRateThreshold"),
    minFailures: config.get("regression.minFailures"),
  };
}

/** Records regression observations and decides, from a window of them, whether
 * a break deserves a card. */
export class RegressionStore {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  async record(input: RegressionRecord, policy: RegressionPolicy): Promise<RegressionResult> {
    const signature = input.outcome === "failed" ? failureSignature(input.output ?? "") : null;
    const time = this.now();
    await this.client.execute({
      sql: `INSERT INTO regression_runs (scenario_id, pool, revision, outcome, failure_signature, ts)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [input.scenarioId, input.pool, input.revision, input.outcome, signature, time],
    });

    const judgement = judgeRegression(await this.history(input.scenarioId, policy.windowSize), policy);
    if (judgement.kind !== "raise") return { judgement, cardRaised: false };

    const inserted = await this.client.execute({
      sql: `INSERT INTO regression_cards (scenario_id, failure_signature, created_at)
            VALUES (?, ?, ?) ON CONFLICT(scenario_id, failure_signature) DO NOTHING`,
      args: [input.scenarioId, judgement.signature, time],
    });
    return { judgement, cardRaised: inserted.rowsAffected === 1 };
  }

  /** Newest first, which is the order the window is read in. */
  async history(scenarioId: string, limit: number): Promise<RegressionObservation[]> {
    const rows = (await this.client.execute({
      sql: `SELECT outcome, failure_signature FROM regression_runs
             WHERE scenario_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
      args: [scenarioId, limit],
    })).rows;
    return rows.map((row) => ({
      outcome: String(row.outcome) as "passed" | "failed",
      failureSignature: row.failure_signature === null ? null : String(row.failure_signature),
    }));
  }

  async openCards(): Promise<Array<{ scenarioId: string; failureSignature: string; attributedStory: string | null }>> {
    const rows = (await this.client.execute(
      "SELECT scenario_id, failure_signature, attributed_story FROM regression_cards ORDER BY created_at, scenario_id",
    )).rows;
    return rows.map((row) => ({
      scenarioId: String(row.scenario_id),
      failureSignature: String(row.failure_signature),
      attributedStory: row.attributed_story === null ? null : String(row.attributed_story),
    }));
  }

  async attribute(scenarioId: string, signature: string, storyId: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE regression_cards SET attributed_story = ?
             WHERE scenario_id = ? AND failure_signature = ?`,
      args: [storyId, scenarioId, signature],
    });
  }
}
