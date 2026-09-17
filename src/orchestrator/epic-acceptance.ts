import { createHash } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { EPIC_BOARD_STATUS, epicStatusStatement } from "./epic-status-projection.js";
import { assertEpicTransition } from "./state-machine.js";

export interface EpicAcceptanceItem {
  prdScenarioId: string;
  text: string;
  status: "open" | "accepted" | "gap";
  notionBlockId: string | null;
  note: string | null;
}

export type EpicAcceptanceOutcome =
  /** Nothing to judge: this Epic carries no PRD scenario of its own. */
  | { kind: "unjudged" }
  | { kind: "waiting"; open: number }
  | { kind: "accepted" }
  | { kind: "gap"; storyIds: string[] };

function hash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Stands in until the Notion page exists; the page delivery replaces it. */
function storyPageId(epicId: string, storyId: string): string {
  const value = hash(`${epicId}:${storyId}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function eventStatement(epicId: string, type: string, data: unknown, time: number): InStatement {
  const runId = `epic-acceptance:${epicId}`;
  return {
    sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
          VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?), ?, NULL, ?, ?, ?)`,
    args: [runId, runId, epicId, type, time, JSON.stringify(data)],
  };
}

/**
 * Scenario-level acceptance, where the delivery it judges happened: on the
 * Epic. A person reads the scenarios this batch promised, ticks the ones it
 * got right, and says in a comment what is missing from the rest -- which
 * becomes another Story under the same Epic rather than a conversation about
 * code. The requirement above only ever summarises these verdicts.
 */
export class EpicAcceptance {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Puts this batch's scenarios up for judgement, in the words the PRD used.
   * Safe to call repeatedly: a scenario already accepted stays accepted, and a
   * gap the follow-up work has since closed opens again.
   */
  async open(epicId: string): Promise<EpicAcceptanceItem[]> {
    const scenarios = await this.carriedScenarios(epicId);
    if (scenarios.length === 0) return [];
    const time = this.now();
    await this.client.batch([
      ...scenarios.map((scenario) => ({
        sql: `INSERT INTO epic_acceptance_items (epic_id, prd_scenario_id, text, status, created_at)
              VALUES (?, ?, ?, 'open', ?)
              ON CONFLICT(epic_id, prd_scenario_id) DO UPDATE SET text = excluded.text`,
        args: [epicId, scenario.id, scenario.text, time],
      })),
      // A scenario the person rejected is up for judgement again now that the
      // work they asked for has been delivered.
      {
        sql: `UPDATE epic_acceptance_items SET status = 'open', decided_at = NULL, note = NULL
              WHERE epic_id = ? AND status = 'gap'`,
        args: [epicId],
      },
      eventStatement(epicId, "epic.acceptance_opened", { scenarioIds: scenarios.map((item) => item.id) }, time),
    ], "write");
    return this.items(epicId);
  }

  async items(epicId: string): Promise<EpicAcceptanceItem[]> {
    const rows = (await this.client.execute({
      sql: `SELECT prd_scenario_id, text, status, notion_block_id, note FROM epic_acceptance_items
            WHERE epic_id = ? ORDER BY prd_scenario_id`,
      args: [epicId],
    })).rows;
    return rows.map((row) => ({
      prdScenarioId: String(row.prd_scenario_id),
      text: String(row.text),
      status: String(row.status) as EpicAcceptanceItem["status"],
      notionBlockId: row.notion_block_id === null ? null : String(row.notion_block_id),
      note: row.note === null ? null : String(row.note),
    }));
  }

  /** The tick a person makes lives on this block, so the projection tells the
   * database which block stands for which scenario. */
  async bindBlock(epicId: string, prdScenarioId: string, notionBlockId: string): Promise<void> {
    const result = await this.client.execute({
      sql: `UPDATE epic_acceptance_items SET notion_block_id = ?
            WHERE epic_id = ? AND prd_scenario_id = ?`,
      args: [notionBlockId, epicId, prdScenarioId],
    });
    if (result.rowsAffected !== 1) throw new Error(`acceptance item does not exist: ${epicId}/${prdScenarioId}`);
  }

  /** A ticked box is a verdict. An unticked one is the absence of one, which
   * is why nothing here ever reads a box as a rejection. */
  async applyCheck(epicId: string, notionBlockId: string): Promise<boolean> {
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE epic_acceptance_items SET status = 'accepted', decided_at = ?
              WHERE epic_id = ? AND notion_block_id = ? AND status = 'open'`,
        args: [time, epicId, notionBlockId],
      },
      {
        sql: "UPDATE epics SET last_human_action_at = ?, updated_at = ? WHERE id = ?",
        args: [time, time, epicId],
      },
      eventStatement(epicId, "epic.acceptance_decided", { notionBlockId, status: "accepted" }, time),
    ], "write");
    return update?.rowsAffected === 1;
  }

  /** What the person said is missing, against the scenario they said it on. */
  async recordGap(epicId: string, prdScenarioId: string, note: string): Promise<boolean> {
    const time = this.now();
    const [update] = await this.client.batch([
      {
        sql: `UPDATE epic_acceptance_items SET status = 'gap', decided_at = ?, note = ?
              WHERE epic_id = ? AND prd_scenario_id = ? AND status = 'open'`,
        args: [time, note, epicId, prdScenarioId],
      },
      {
        sql: "UPDATE epics SET last_human_action_at = ?, updated_at = ? WHERE id = ?",
        args: [time, time, epicId],
      },
      eventStatement(epicId, "epic.acceptance_decided", { prdScenarioId, status: "gap", note }, time),
    ], "write");
    return update?.rowsAffected === 1;
  }

  /**
   * Closes the round once every scenario has a verdict. All ticked leaves the
   * Epic for the merge to finish; anything missing becomes one Story per gap
   * under this same Epic, and the batch goes back to work.
   */
  async settle(epicId: string): Promise<EpicAcceptanceOutcome> {
    const items = await this.items(epicId);
    if (items.length === 0) return { kind: "unjudged" };
    const open = items.filter((item) => item.status === "open");
    if (open.length > 0) return { kind: "waiting", open: open.length };
    const gaps = items.filter((item) => item.status === "gap");
    if (gaps.length === 0) return { kind: "accepted" };
    return { kind: "gap", storyIds: await this.openGapStories(epicId, gaps) };
  }

  /** One Story per gap, carrying the scenario and the person's own words. */
  private async openGapStories(epicId: string, gaps: readonly EpicAcceptanceItem[]): Promise<string[]> {
    const epic = (await this.client.execute({
      sql: "SELECT state, repo FROM epics WHERE id = ?",
      args: [epicId],
    })).rows[0];
    if (!epic) throw new Error(`Epic ${epicId} is not in the central database`);
    const used = (await this.client.execute({
      sql: "SELECT id FROM stories WHERE epic_id = ?",
      args: [epicId],
    })).rows.map((row) => String(row.id));
    let next = used.length;
    const time = this.now();
    const statements: InStatement[] = [];
    const storyIds: string[] = [];
    for (const gap of gaps) {
      let storyId = "";
      do {
        next++;
        storyId = `S-${epicId}-${String(next).padStart(2, "0")}`;
      } while (used.includes(storyId));
      used.push(storyId);
      storyIds.push(storyId);
      const requirement = [
        `验收时这条场景没有通过，本张卡把它补上。`,
        `场景：${gap.text}`,
        ...(gap.note?.trim() ? [`验收人说：${gap.note.trim()}`] : []),
      ].join("\n");
      const payload = JSON.stringify({ epicId, storyId });
      statements.push({
        sql: `INSERT OR IGNORE INTO stories
                (id, epic_id, notion_page_id, title, requirement, state, repo, target_branch, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`,
        args: [storyId, epicId, storyPageId(epicId, storyId), `补交付：${gap.text}`,
          requirement, epic.repo ?? null, epic.target_branch ?? null, time, time],
      }, {
        sql: `INSERT OR IGNORE INTO execution_dispatches (story_id, epic_id, state, created_at)
              VALUES (?, ?, 'pending', ?)`,
        args: [storyId, epicId, time],
      }, {
        sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
              VALUES (?, 1, 'create_story_page', ?, ?, ?, ?)
              ON CONFLICT(target, payload_hash) DO NOTHING`,
        args: [storyId, epicId, payload, hash(payload), time],
      });
    }
    // The batch is not finished after all, so it goes back to work with a
    // review request that will be reopened once the follow-up lands.
    if (String(epic.state) === "EPIC_ACCEPT") {
      assertEpicTransition("EPIC_ACCEPT", "EXECUTING");
      statements.push({
        sql: `UPDATE epics SET state = 'EXECUTING', mr_url = NULL, updated_at = ?
              WHERE id = ? AND state = 'EPIC_ACCEPT'`,
        args: [time, epicId],
      }, epicStatusStatement(epicId, EPIC_BOARD_STATUS.executing, time, "EXECUTING"));
    }
    statements.push(eventStatement(epicId, "epic.acceptance_gap_stories", { storyIds }, time));
    await this.client.batch(statements, "write");
    return storyIds;
  }

  /** The PRD scenarios this Epic answers for, in the words the PRD used. */
  private async carriedScenarios(epicId: string): Promise<Array<{ id: string; text: string }>> {
    const epic = (await this.client.execute({
      sql: "SELECT requirement_id FROM epics WHERE id = ?",
      args: [epicId],
    })).rows[0];
    if (!epic || epic.requirement_id === null) return [];
    const requirementId = String(epic.requirement_id);
    const carried = (await this.client.execute({
      sql: `SELECT prd_scenario_id FROM epic_prd_scenarios
            WHERE requirement_id = ? AND epic_id = ? ORDER BY prd_scenario_id`,
      args: [requirementId, epicId],
    })).rows.map((row) => String(row.prd_scenario_id));
    if (carried.length === 0) return [];
    const prd = (await this.client.execute({
      sql: `SELECT body FROM requirement_prds
            WHERE requirement_id = ? AND status = 'confirmed' ORDER BY revision DESC LIMIT 1`,
      args: [requirementId],
    })).rows[0];
    if (!prd) return [];
    const scenarios = (JSON.parse(String(prd.body)) as {
      scenarios?: Array<{ id: string; given: string; when: string; then: string }>;
    }).scenarios ?? [];
    const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    return carried.flatMap((id) => {
      const scenario = byId.get(id);
      // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external PRD contract.
      return scenario ? [{ id, text: `${scenario.given}，${scenario.when}，${scenario.then}` }] : [];
    });
  }
}
