import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { RequirementPagePublisher } from "./clarify-loop.js";
import type { EpicIntake } from "./decompose-runner.js";
import type { PrdScenario } from "./requirement-artifacts.js";
import type { AcceptanceItem, RequirementStore } from "./requirement-store.js";

export interface ChecklistItem {
  itemId: string;
  prdScenarioId: string;
  text: string;
}

const NO_EPIC_CARRIED = "\u6ca1\u6709\u4efb\u4f55\u4e00\u6279\u4ea4\u4ed8\u627f\u63a5\u8fd9\u6761\u573a\u666f\uff0c\u672c\u6279\u628a\u5b83\u8865\u4e0a\u3002";

export type AcceptanceOutcome =
  /** A verdict is missing, which only a rerun of the Epics can produce. */
  | { kind: "waiting"; open: number }
  | { kind: "accepted" }
  | { kind: "gap"; epic: EpicIntake };

function hash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function epicPageId(requirementId: string, epicId: string): string {
  const value = hash(`${requirementId}:${epicId}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

/** Reuses the requirement's own identifier so the Epic is traceable to it and
 * still short enough to prefix Story ids. */
function gapEpicId(requirementId: string, round: number): string {
  const token = requirementId.replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 7);
  return `${token}G${round}`;
}

/**
 * One checklist item per PRD scenario, in the words the scenario already used.
 * The mapping is one-to-one on purpose: a person judging the list is judging
 * the PRD they approved, not a summary somebody wrote afterwards.
 */
export function buildChecklist(scenarios: readonly PrdScenario[]): ChecklistItem[] {
  return scenarios.map((scenario, index) => ({
    itemId: `A${String(index + 1).padStart(2, "0")}`,
    prdScenarioId: scenario.id,
    text: `${scenario.given}，${scenario.when}，${scenario.then}`,
  }));
}

/**
 * Summarises what the Epics already decided. The judgement happens on each
 * batch, where the person saw the delivery; asking them to tick the same
 * scenarios a second time at the end teaches them to click through a list
 * without reading it. What is left here is arithmetic: every scenario a batch
 * accepted closes the requirement, and one no batch ever carried is a hole in
 * the split, which becomes one more delivery batch.
 */
export class AcceptanceChecklist {
  constructor(
    private readonly client: Client,
    private readonly store: RequirementStore,
    private readonly publisher: RequirementPagePublisher,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Closes a requirement whose Epics are all finished. Safe to call
   * repeatedly: seeding and each verdict are written once, so a crash between
   * them costs a repeat, not a second decision.
   */
  async settle(requirementId: string): Promise<AcceptanceOutcome> {
    const requirement = await this.store.getRequirement(requirementId);
    if (requirement.state === "EXECUTING") {
      const epics = await this.store.linkedEpicStates(requirementId);
      if (epics.length === 0 || !epics.every((epic) => epic.state === "DONE")) {
        throw new Error(`requirement ${requirementId} still has Epics in flight`);
      }
      await this.store.transition(requirementId, "EXECUTING", "ACCEPTANCE", "system", runId(requirementId));
    } else if (requirement.state !== "ACCEPTANCE") {
      throw new Error(`requirement ${requirementId} is ${requirement.state}, not ready for acceptance`);
    }

    const prd = await this.store.getPrd(requirementId);
    if (!prd || prd.status !== "confirmed") throw new Error(`requirement ${requirementId} has no confirmed PRD`);
    const scenarios = (JSON.parse(prd.body) as { scenarios: PrdScenario[] }).scenarios;
    await this.store.seedAcceptanceItems(requirementId, buildChecklist(scenarios), runId(requirementId));
    await this.copyEpicVerdicts(requirementId);

    const items = await this.store.acceptanceItems(requirementId);
    const open = items.filter((item) => item.status === "open");
    if (open.length > 0) return { kind: "waiting", open: open.length };

    const gaps = items.filter((item) => item.status === "gap");
    if (gaps.length === 0) {
      await this.store.transition(requirementId, "ACCEPTANCE", "DONE", "system", runId(requirementId));
      await this.publisher.publish(requirementId);
      return { kind: "accepted" };
    }

    const notes = await this.store.acceptanceGapNotes(requirementId);
    const round = (await this.store.settledAcceptanceGapRounds(requirementId)) + 1;
    const epic = await this.writeGapEpic(requirement.id, requirement.repo, round, gaps, notes);
    await this.store.reopenAcceptanceGaps(requirementId, runId(requirementId));
    await this.store.transition(requirementId, "ACCEPTANCE", "DECOMPOSING", "system", runId(requirementId));
    await this.store.transition(requirementId, "DECOMPOSING", "EXECUTING", "system", runId(requirementId));
    await this.publisher.publish(requirementId);
    return { kind: "gap", epic };
  }

  /**
   * Each scenario takes the verdict of the batch that carried it. A scenario
   * no batch carried has nobody who could have judged it, and is recorded as
   * missing rather than quietly counted as delivered.
   */
  private async copyEpicVerdicts(requirementId: string): Promise<void> {
    const decided = new Map((await this.client.execute({
      sql: `SELECT i.prd_scenario_id, i.status, i.note FROM epic_acceptance_items i
              JOIN epics e ON e.id = i.epic_id
             WHERE e.requirement_id = ?`,
      args: [requirementId],
    })).rows.map((row) => [String(row.prd_scenario_id), {
      status: String(row.status),
      note: row.note === null ? "" : String(row.note),
    }] as const));

    for (const item of await this.store.acceptanceItems(requirementId)) {
      if (item.status !== "open") continue;
      const verdict = decided.get(item.prdScenarioId);
      const eventId = `epic-verdict:${requirementId}:${item.itemId}`;
      if (verdict?.status === "accepted") {
        await this.store.decideAcceptanceItem(
          requirementId, item.itemId, "accepted", eventId, "auto", runId(requirementId),
        );
        continue;
      }
      if (verdict === undefined) {
        await this.store.decideAcceptanceItem(
          requirementId, item.itemId, "gap", eventId, "auto", runId(requirementId),
          NO_EPIC_CARRIED,
        );
      }
    }
  }

  private async writeGapEpic(
    requirementId: string,
    repo: string | undefined,
    round: number,
    gaps: readonly AcceptanceItem[],
    notes: ReadonlyMap<string, string>,
  ): Promise<EpicIntake> {
    const epicId = gapEpicId(requirementId, round);
    const title = `${epicId} 验收缺口补齐（第 ${round} 次）`;
    const lines = ["验收时以下场景没有被判定通过，本批交付把它们补齐。", ""];
    for (const gap of gaps) {
      lines.push(`- 场景：${gap.text}`);
      const note = notes.get(gap.itemId)?.trim();
      if (note) lines.push(`  验收人反馈：${note}`);
    }
    const body = lines.join("\n");
    const time = this.now();
    const pageId = epicPageId(requirementId, epicId);
    const payload = JSON.stringify({
      requirementId,
      epicId,
      title,
      body,
      scenarioIds: gaps.map((gap) => gap.prdScenarioId),
    });
    await this.client.batch([
      {
        sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, repo, created_at, updated_at)
              VALUES (?, ?, ?, 'INTAKE', ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
        args: [epicId, pageId, title, requirementId, repo ?? null, time, time],
      },
      {
        sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
              VALUES (?, 1, 'create_epic_page', ?, ?, ?, ?)
              ON CONFLICT(target, payload_hash) DO NOTHING`,
        args: [epicId, requirementId, payload, hash(payload), time],
      },
    ], "write");
    return { id: epicId, notionPageId: pageId, title, requirement: body };
  }
}

function runId(requirementId: string): string {
  return `requirement:${requirementId}`;
}
