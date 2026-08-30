import { createHash } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import type { DecompositionCandidate, DecompositionStory } from "./decompose.js";
import { evaluateDecomposition } from "./decompose.js";
import { assertEpicTransition, type EpicState } from "./state-machine.js";

export type ApprovalSource = "comment" | "drag";

export interface PresentPlanInput {
  epicId: string;
  notionPageId: string;
  title: string;
  plan: DecompositionCandidate;
}

export interface ApprovalInput {
  epicId: string;
  eventId: string;
  source: ApprovalSource;
}

export interface EpicApprovalSnapshot {
  id: string;
  state: EpicState;
}

function hash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function storyPageId(epicId: string, storyId: string): string {
  const value = hash(`${epicId}:${storyId}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function presentationPayload(plan: DecompositionCandidate): string {
  return JSON.stringify({
    epicId: plan.epicId,
    status: "拆解待确认",
    businessGoal: plan.businessGoal,
    stories: plan.stories.map((story) => ({ id: story.id, title: story.title })),
  });
}

/** The durable gate between accepted decomposition and any executable Story. */
export class PlanApprovalStore {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  async present(input: PresentPlanInput): Promise<void> {
    const accepted = evaluateDecomposition(input.plan);
    if (accepted.kind !== "accepted" || accepted.epicId !== input.epicId) {
      throw new Error("only an accepted decomposition for this Epic can await approval");
    }
    const time = this.now();
    const body = presentationPayload(input.plan);
    await this.client.batch([
      {
        sql: `INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at)
              VALUES (?, ?, ?, 'PLAN_APPROVAL', ?, ?)
              ON CONFLICT(id) DO UPDATE SET title = excluded.title, state = 'PLAN_APPROVAL', updated_at = excluded.updated_at`,
        args: [input.epicId, input.notionPageId, input.title, time, time],
      },
      {
        sql: `INSERT INTO epic_plans (epic_id, body, created_at, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(epic_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
        args: [input.epicId, JSON.stringify(accepted), time, time],
      },
      {
        sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
              VALUES (?, 1, 'present_epic_plan', ?, ?, ?, ?)
              ON CONFLICT(target, payload_hash) DO NOTHING`,
        args: [input.epicId, input.notionPageId, body, hash(body), time],
      },
    ], "write");
  }

  async getEpic(epicId: string): Promise<EpicApprovalSnapshot> {
    const row = (await this.client.execute({ sql: "SELECT id, state FROM epics WHERE id = ?", args: [epicId] })).rows[0];
    if (!row) throw new Error(`Epic ${epicId} does not exist`);
    return { id: String(row.id), state: String(row.state) as EpicState };
  }

  async approve(input: ApprovalInput): Promise<boolean> {
    const time = this.now();
    const epic = await this.getEpic(input.epicId);
    if (epic.state !== "PLAN_APPROVAL") return false;
    assertEpicTransition(epic.state, "EXECUTING");
    const planRow = (await this.client.execute({ sql: "SELECT body FROM epic_plans WHERE epic_id = ?", args: [input.epicId] })).rows[0];
    if (!planRow) throw new Error(`Epic ${input.epicId} has no accepted plan`);
    const plan = JSON.parse(String(planRow.body)) as { stories: DecompositionStory[] };
    const statements: InStatement[] = [{
      sql: `INSERT INTO epic_approval_events (event_id, epic_id, source, created_at)
            VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`,
      args: [input.eventId, input.epicId, input.source, time],
    }];
    for (const story of plan.stories) {
      const payload = JSON.stringify({ epicId: input.epicId, storyId: story.id });
      statements.push({
        sql: `INSERT OR IGNORE INTO stories
              (id, epic_id, notion_page_id, title, requirement, state, depends_on, predicted_footprint, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`,
        args: [story.id, input.epicId, storyPageId(input.epicId, story.id), story.title, story.requirement,
          JSON.stringify(story.dependsOn), JSON.stringify(story.predictedFootprint), time, time],
      }, {
        sql: `INSERT OR IGNORE INTO execution_dispatches (story_id, epic_id, state, created_at)
              VALUES (?, ?, 'pending', ?)`,
        args: [story.id, input.epicId, time],
      }, {
        sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
              VALUES (?, 1, 'create_story_page', ?, ?, ?, ?)
              ON CONFLICT(target, payload_hash) DO NOTHING`,
        args: [story.id, input.epicId, payload, hash(payload), time],
      });
    }
    statements.push({
      sql: `UPDATE epics SET state = 'EXECUTING', updated_at = ?
            WHERE id = ? AND state = 'PLAN_APPROVAL'
              AND EXISTS (SELECT 1 FROM epic_approval_events WHERE event_id = ?)`,
      args: [time, input.epicId, input.eventId],
    });
    const result = await this.client.batch(statements, "write");
    return result.at(-1)?.rowsAffected === 1;
  }
}
