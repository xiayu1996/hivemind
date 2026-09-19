import type { Client } from "@libsql/client";
import type { ConfigStore } from "../config/store.js";
import type { ScenarioPool } from "./scenario-registry.js";
import {
  failureSignature,
  judgeRegression,
  normalizeFailureText,
  type RegressionJudgement,
  type RegressionObservation,
  type RegressionPolicy,
} from "./verdict.js";

/** Enough of the break to act on, short enough to sit in a prompt beside the
 * rest of the round's context. */
const FAILURE_TEXT_LIMIT = 2_000;

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
  /** True when this observation opened a card; false when the scenario was
   * already carrying one. */
  cardRaised: boolean;
  /** Signatures of cards this observation closed, if any. */
  cardsCleared: readonly string[];
}

export async function regressionPolicy(config: ConfigStore): Promise<RegressionPolicy> {
  await config.reload();
  return {
    windowSize: config.get("regression.windowSize"),
    failureRateThreshold: config.get("regression.failureRateThreshold"),
    minFailures: config.get("regression.minFailures"),
  };
}

export interface OpenRegressionCard {
  scenarioId: string;
  failureSignature: string;
  /** The break in words. Null only for a card raised before this was kept. */
  failureText: string | null;
  attributedStory: string | null;
}

/** Records regression observations and decides, from a window of them, whether
 * a break deserves a card. */
export class RegressionStore {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  async record(input: RegressionRecord, policy: RegressionPolicy): Promise<RegressionResult> {
    const failed = input.outcome === "failed";
    const signature = failed ? failureSignature(input.output ?? "") : null;
    // The same text the hash is taken over, bounded: a card carries it to the
    // Story reopened to fix the break, and a hash tells that Story nothing.
    const text = failed ? normalizeFailureText(input.output ?? "").slice(0, FAILURE_TEXT_LIMIT) : null;
    const time = this.now();
    await this.client.execute({
      sql: `INSERT INTO regression_runs (scenario_id, pool, revision, outcome, failure_signature, failure_text, ts)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [input.scenarioId, input.pool, input.revision, input.outcome, signature, text, time],
    });

    const judgement = judgeRegression(await this.history(input.scenarioId, policy.windowSize), policy);
    // The rule a card is raised under, read the other way round. A card names
    // a break that is happening now; with the whole window green it is not
    // happening any more, and nothing is left for anyone to reproduce. Without
    // this the only way to close a card is the attributed Story's fix round,
    // so a card bisection could not attribute -- one it judged not reproduced,
    // for instance -- stayed open with no actor in the system able to close it
    // and held its Epic back for good.
    if (judgement.kind === "stable") {
      return { judgement, cardRaised: false, cardsCleared: await this.clearCards(input.scenarioId, time) };
    }
    if (judgement.kind !== "raise") return { judgement, cardRaised: false, cardsCleared: [] };

    // One open card per scenario. A scenario that is simply broken fails in a
    // new signature every sweep when a person writing about the screen is what
    // produces the text, so keying the card on the break alone opened another
    // one every round: the same work item, worded differently, piling up in
    // the Story's fix round and in the Epic's gate message.
    const inserted = await this.client.execute({
      sql: `INSERT INTO regression_cards (scenario_id, failure_signature, failure_text, created_at)
            SELECT ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM regression_cards
                                WHERE scenario_id = ? AND resolved_at IS NULL)
            ON CONFLICT(scenario_id, failure_signature) DO UPDATE
              SET resolved_at = NULL, created_at = excluded.created_at
              WHERE regression_cards.resolved_at IS NOT NULL`,
      args: [input.scenarioId, judgement.signature, text, time, input.scenarioId],
    });
    return { judgement, cardRaised: inserted.rowsAffected === 1, cardsCleared: [] };
  }

  /**
   * Closes every open card on a scenario the evidence no longer shows broken.
   * Unlike `resolveCard` this asks for no owner: it is the sweep closing what
   * the sweep opened, and the Epic gate still demands a passing run at the
   * revision a review request proposes, so a head that is actually red is held
   * by that limb rather than by a card nobody can act on.
   */
  private async clearCards(scenarioId: string, now: number): Promise<string[]> {
    const rows = (await this.client.execute({
      sql: `UPDATE regression_cards SET resolved_at = ?
             WHERE scenario_id = ? AND resolved_at IS NULL
         RETURNING failure_signature`,
      args: [now, scenarioId],
    })).rows;
    return rows.map((row) => String(row.failure_signature));
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

  /** Cards nobody has closed yet. With an Epic id, only the cards attributed to
   * one of that Epic's Stories; an unattributed card belongs to no Epic. */
  async openCards(epicId?: string): Promise<OpenRegressionCard[]> {
    const rows = (await this.client.execute(epicId === undefined
      ? `SELECT scenario_id, failure_signature, failure_text, attributed_story FROM regression_cards
          WHERE resolved_at IS NULL ORDER BY created_at, scenario_id`
      : {
        sql: `SELECT c.scenario_id, c.failure_signature, c.failure_text, c.attributed_story
                FROM regression_cards c JOIN stories s ON s.id = c.attributed_story
               WHERE c.resolved_at IS NULL AND s.epic_id = ?
               ORDER BY c.created_at, c.scenario_id`,
        args: [epicId],
      })).rows;
    return rows.map(toOpenCard);
  }

  /**
   * Open cards nobody owns yet, among the scenarios named. Every other query
   * reaches a card through its attributed Story, so a card without one is
   * invisible to the Epic it blocks and to the only actor that could close it.
   * Attribution is retried from here each sweep rather than only at the moment
   * a card is raised, because a card that found no owner once would otherwise
   * never be offered one again.
   */
  async unattributedCards(scenarioIds: readonly string[]): Promise<OpenRegressionCard[]> {
    if (scenarioIds.length === 0) return [];
    const rows = (await this.client.execute({
      sql: `SELECT scenario_id, failure_signature, failure_text, attributed_story FROM regression_cards
             WHERE resolved_at IS NULL AND attributed_story IS NULL
               AND scenario_id IN (${scenarioIds.map(() => "?").join(", ")})
             ORDER BY created_at, scenario_id`,
      args: [...scenarioIds],
    })).rows;
    return rows.map(toOpenCard);
  }

  /** The open cards a REGRESSION_FIX round of this Story has to answer for. */
  async openCardsForStory(storyId: string): Promise<OpenRegressionCard[]> {
    const rows = (await this.client.execute({
      sql: `SELECT scenario_id, failure_signature, failure_text, attributed_story FROM regression_cards
             WHERE resolved_at IS NULL AND attributed_story = ? ORDER BY created_at, scenario_id`,
      args: [storyId],
    })).rows;
    return rows.map(toOpenCard);
  }

  async attribute(scenarioId: string, signature: string, storyId: string): Promise<void> {
    await this.client.execute({
      sql: `UPDATE regression_cards SET attributed_story = ?
             WHERE scenario_id = ? AND failure_signature = ?`,
      args: [storyId, scenarioId, signature],
    });
  }

  /**
   * Closes a card on behalf of the Story that fixed it. The Story must be the
   * one the card was attributed to: a card another Story happened to see green
   * is not evidence its own break is gone. Returns whether a card was closed.
   */
  async resolveCard(scenarioId: string, signature: string, storyId: string, now: number = this.now()): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE regression_cards SET resolved_at = ?
             WHERE scenario_id = ? AND failure_signature = ? AND attributed_story = ? AND resolved_at IS NULL`,
      args: [now, scenarioId, signature, storyId],
    });
    return result.rowsAffected === 1;
  }
}

function toOpenCard(row: Record<string, unknown>): OpenRegressionCard {
  return {
    scenarioId: String(row.scenario_id),
    failureSignature: String(row.failure_signature),
    failureText: row.failure_text === null || row.failure_text === undefined ? null : String(row.failure_text),
    attributedStory: row.attributed_story === null ? null : String(row.attributed_story),
  };
}
