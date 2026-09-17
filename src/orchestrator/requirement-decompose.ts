import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { RequirementPagePublisher } from "./clarify-loop.js";
import type { EpicIntake } from "./decompose-runner.js";
import {
  evaluateRequirementDecomposition,
  type PrdScenario,
  type RequirementDecompositionCandidate,
} from "./requirement-artifacts.js";
import type { RequirementStore } from "./requirement-store.js";

export interface RequirementDecomposeRequest {
  requirementId: string;
  title: string;
  businessGoal: string;
  nonGoals: readonly string[];
  scenarios: readonly PrdScenario[];
  previousRejections: readonly string[];
}

export interface RequirementDecomposePort {
  run(input: RequirementDecomposeRequest): Promise<RequirementDecompositionCandidate>;
}

export type RequirementDecomposeOutcome =
  | { kind: "decomposed"; epics: readonly EpicIntake[] }
  | { kind: "stopped"; reason: string };

const MAX_ATTEMPTS = 2;

function hash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Stands in until the Notion page exists; the page delivery replaces it. */
function epicPageId(requirementId: string, epicId: string): string {
  const value = hash(`${requirementId}:${epicId}`);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

/**
 * Splits a confirmed PRD into delivery batches. The Epics it writes are
 * ordinary board Epics: they enter the existing intake and decomposition
 * untouched, which is the point — the product manager hands work over, it does
 * not run a second pipeline of its own.
 */
export class RequirementDecomposer {
  constructor(
    private readonly client: Client,
    private readonly store: RequirementStore,
    private readonly port: RequirementDecomposePort,
    private readonly publisher: RequirementPagePublisher,
    private readonly now: () => number = Date.now,
  ) {}

  async decompose(requirementId: string): Promise<RequirementDecomposeOutcome> {
    const requirement = await this.store.getRequirement(requirementId);
    if (requirement.state !== "DECOMPOSING") {
      throw new Error(`requirement ${requirementId} is ${requirement.state}, not being decomposed`);
    }
    if (requirement.stopReason) return { kind: "stopped", reason: requirement.stopReason };

    const prd = await this.store.getPrd(requirementId);
    if (!prd || prd.status !== "confirmed") {
      throw new Error(`requirement ${requirementId} has no confirmed PRD to decompose`);
    }
    const body = JSON.parse(prd.body) as {
      businessGoal: string;
      nonGoals: string[];
      scenarios: PrdScenario[];
    };
    const scenarioIds = body.scenarios.map((scenario) => scenario.id);

    const rejections: string[] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = await this.port.run({
        requirementId,
        title: requirement.title,
        businessGoal: body.businessGoal,
        nonGoals: body.nonGoals,
        scenarios: body.scenarios,
        previousRejections: [...rejections],
      });
      const evaluated = evaluateRequirementDecomposition(scenarioIds, candidate);
      if (evaluated.kind === "rejected") {
        rejections.push(...evaluated.reasons);
        continue;
      }
      const taken = await this.takenEpicIds(evaluated.epics.map((epic) => epic.id), requirementId);
      if (taken.length > 0) {
        rejections.push(`these Epic ids are already used by other work: ${taken.join(", ")}`);
        continue;
      }
      const intakes = await this.write(requirement.id, requirement.repo, evaluated.epics);
      await this.store.transition(requirementId, "DECOMPOSING", "EXECUTING", "system", runId(requirementId));
      await this.publisher.publish(requirementId);
      return { kind: "decomposed", epics: intakes };
    }

    const reason = `requirement decomposition was unusable: ${rejections.join("; ")}`;
    await this.store.stopForHumanInput(requirementId, "DECOMPOSING", runId(requirementId), reason);
    await this.publisher.publish(requirementId);
    return { kind: "stopped", reason };
  }

  /** True only when every Epic born from this requirement is delivered. */
  async canEnterAcceptance(requirementId: string): Promise<boolean> {
    const epics = await this.store.linkedEpicStates(requirementId);
    return epics.length > 0 && epics.every((epic) => epic.state === "DONE");
  }

  private async takenEpicIds(ids: readonly string[], requirementId: string): Promise<string[]> {
    const rows = (await this.client.execute({
      sql: `SELECT id FROM epics
            WHERE id IN (${ids.map(() => "?").join(",")})
              AND (requirement_id IS NULL OR requirement_id <> ?)`,
      args: [...ids, requirementId],
    })).rows;
    return rows.map((row) => String(row.id));
  }

  private async write(
    requirementId: string,
    repo: string | undefined,
    epics: readonly { id: string; title: string; businessGoal: string; body: string; scenarioIds: readonly string[] }[],
  ): Promise<EpicIntake[]> {
    const time = this.now();
    const intakes: EpicIntake[] = [];
    const statements = [];
    for (const epic of epics) {
      // The id travels in its own column. A title that repeats it costs a
      // reader the same words on the board, the page and every mention of it.
      const title = epic.title;
      const requirementBody = `${epic.businessGoal}\n\n${epic.body}`;
      const pageId = epicPageId(requirementId, epic.id);
      // The page gets the description alone: the business goal is rendered by
      // the projection under its own heading, next to the scenarios it carries.
      const payload = JSON.stringify({
        requirementId,
        epicId: epic.id,
        title,
        body: epic.body,
        scenarioIds: [...epic.scenarioIds],
      });
      statements.push({
        sql: `INSERT INTO epics
                (id, notion_page_id, title, state, requirement_id, business_goal, repo, created_at, updated_at)
              VALUES (?, ?, ?, 'INTAKE', ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                requirement_id = excluded.requirement_id,
                business_goal = excluded.business_goal,
                repo = COALESCE(epics.repo, excluded.repo),
                updated_at = excluded.updated_at`,
        args: [epic.id, pageId, title, requirementId, epic.businessGoal, repo ?? null, time, time],
      }, {
        sql: `INSERT INTO notion_outbox (card_id, priority, operation, target, payload, payload_hash, created_at)
              VALUES (?, 1, 'create_epic_page', ?, ?, ?, ?)
              ON CONFLICT(target, payload_hash) DO NOTHING`,
        args: [epic.id, requirementId, payload, hash(payload), time],
      });
      // Which batch answers for which PRD scenario. The primary key makes a
      // rerun move a scenario to its new Epic rather than let two claim it.
      for (const scenarioId of epic.scenarioIds) {
        statements.push({
          sql: `INSERT INTO epic_prd_scenarios (requirement_id, epic_id, prd_scenario_id)
                VALUES (?, ?, ?)
                ON CONFLICT(requirement_id, prd_scenario_id) DO UPDATE SET epic_id = excluded.epic_id`,
          args: [requirementId, epic.id, scenarioId],
        });
      }
      intakes.push({ id: epic.id, notionPageId: pageId, title, requirement: requirementBody });
    }
    await this.client.batch(statements, "write");
    return intakes;
  }
}

function runId(requirementId: string): string {
  return `requirement:${requirementId}`;
}
