import type { Client, Row } from "@libsql/client";
import type { CanonicalEvent } from "../observability/canonical-log.js";
import { ProjectionRegistry } from "../observability/projections/registry.js";
import { renderTraceHtml } from "../observability/projections/trace-html.js";
import { traceProjection } from "../observability/projections/units.js";
import { summarizeFootprintDeviation } from "../orchestrator/footprint-deviation.js";
import type { ConsoleDataSource } from "./server.js";
import { notionPageUrl } from "./notion-link.js";
import { formatWaitingDuration } from "./work-status-time.js";

function plain(row: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row));
}

export class LibsqlConsoleDataSource implements ConsoleDataSource {
  constructor(
    private readonly client: Client,
    private readonly nodeSnapshot: () => Promise<unknown[]>,
    private readonly now: () => number = Date.now,
  ) {}

  nodes(): Promise<unknown[]> {
    return this.nodeSnapshot();
  }

  async tasks(): Promise<unknown[]> {
    const stories = (await this.client.execute(
      "SELECT id, title, state, phase, branch, updated_at FROM stories ORDER BY updated_at DESC",
    )).rows;
    return Promise.all(stories.map(async (story) => {
      const eventRows = (await this.client.execute({
        sql: "SELECT run_id, type, seq, ts, data FROM event_log WHERE card_id = ? ORDER BY ts, run_id, seq",
        args: [String(story.id)],
      })).rows;
      const events = eventRows.map((event) => ({
        runId: String(event.run_id),
        type: String(event.type),
        seq: Number(event.seq),
        time: Number(event.ts),
        data: JSON.parse(String(event.data)),
      }));
      const byRun = new Map<string, typeof events>();
      for (const event of events) {
        const group = byRun.get(event.runId) ?? [];
        group.push(event);
        byRun.set(event.runId, group);
      }
      const traces: string[] = [];
      for (const [runId, runEvents] of byRun) {
        const registry = new ProjectionRegistry(runId, [traceProjection] as never);
        await registry.rebuild(runEvents.toSorted((a, b) => a.seq - b.seq) satisfies CanonicalEvent[]);
        traces.push(`<section data-run-id="${encodeURIComponent(runId)}">${renderTraceHtml(registry.view("trace"))}</section>`);
      }
      return Object.assign(plain(story), {
        events,
        traceHtml: traces.join(""),
      });
    }));
  }

  async costs(): Promise<unknown[]> {
    return (await this.client.execute(
      `SELECT run_id, card_id, phase, purpose, tier, provider, model_id, host_id,
              uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, cost_usd, ts
         FROM cost_entries ORDER BY ts DESC`,
    )).rows.map(plain);
  }

  /** DECOMPOSE quality: only Stories whose actual footprint was captured at merge can be scored. */
  async stats(): Promise<unknown> {
    const rows = (await this.client.execute(
      "SELECT id, predicted_footprint, actual_footprint FROM stories WHERE actual_footprint IS NOT NULL ORDER BY id",
    )).rows;
    return {
      footprintDeviation: summarizeFootprintDeviation(rows.map((row) => ({
        storyId: String(row.id),
        predictedFootprint: JSON.parse(String(row.predicted_footprint)),
        actualFootprint: JSON.parse(String(row.actual_footprint)),
      }))),
    };
  }

  /** Breaker state is central because one account per vendor makes it shared. */
  async providers(): Promise<unknown[]> {
    return (await this.client.execute(
      `SELECT provider, state, consecutive_failures, opened_at, retry_at, needs_human,
              last_error_class, last_error, last_probe_at, updated_at
         FROM provider_health ORDER BY provider`,
    )).rows.map(plain);
  }

  async config(): Promise<unknown[]> {
    return (await this.client.execute(
      "SELECT scope_id, key, value_json, version, updated_by, updated_at FROM config_entries ORDER BY scope_id, key",
    )).rows.map((row) => Object.assign(plain(row), {
      value: JSON.parse(String(row.value_json)),
    }));
  }

  /** Only the central gate registry can create a pending response. */
  async workStatus(): Promise<unknown> {
    const [gates, requirements] = await Promise.all([
      this.client.execute(`SELECT id, object_type AS objectType, object_id AS objectId,
                                  required_action AS requiredAction, phase AS whereThisArose,
                                  recommended_choice AS recommendedChoice,
                                  recommendation_reason AS recommendationReason,
                                  other_options AS otherOptions,
                                  confirmation_reason AS confirmationReason,
                                  navigation_target AS navigationTarget
                             FROM human_gates
                            WHERE state = 'open'
                            ORDER BY priority, created_at, id`),
      this.client.execute(`SELECT r.id AS id, r.title AS title, r.notion_page_id AS notion_page_id,
                                  s.id AS story_id,
                                  COALESCE(s.phase, s.state) AS phase, s.title AS working_on,
                                  s.phase_started_at
                             FROM requirements r
                             JOIN epics e ON e.requirement_id = r.id
                             JOIN stories s ON s.epic_id = e.id
                            WHERE r.state = 'EXECUTING'
                              AND s.id = (
                                SELECT candidate.id
                                  FROM stories candidate
                                  JOIN epics candidate_epic ON candidate_epic.id = candidate.epic_id
                                 WHERE candidate_epic.requirement_id = r.id
                                   AND candidate.state IN ('QUEUED', 'DESIGN', 'CODE', 'VERIFY', 'MERGE', 'REGRESSION_FIX')
                                   AND candidate.phase_started_at IS NOT NULL
                                 ORDER BY candidate.phase_started_at DESC, candidate.id ASC
                                 LIMIT 1
                              )
                            ORDER BY r.updated_at DESC, r.id`),
    ]);
    const gatePageIds = await this.resolveGatePageIds(gates.rows);
    const pendingResponses = gates.rows.map((gate) => {
      const response = plain(gate);
      const requiredText = [
        response.requiredAction,
        response.recommendedChoice,
        response.recommendationReason,
        response.whereThisArose,
        response.confirmationReason,
      ];
      if (!requiredText.every((value) => typeof value === "string" && value.trim() !== "")) {
        throw new Error("incomplete open human gate");
      }
      const recommendedChoice = response.recommendedChoice as string;
      let otherOptions: unknown;
      try {
        otherOptions = JSON.parse(String(response.otherOptions));
      } catch {
        throw new Error("incomplete open human gate");
      }
      if (!Array.isArray(otherOptions) || otherOptions.length === 0
        || !otherOptions.every((option) => typeof option === "string" && option.trim() !== "")
        || otherOptions.some((option) => option.trim() === recommendedChoice.trim())) {
        throw new Error("incomplete open human gate");
      }
      const pageId = gatePageIds.get(String(response.id)) ?? null;
      // An unresolvable object or a missing page id means the link would point
      // nowhere, so the whole view fails rather than showing an untrusted entry.
      if (pageId === null || pageId.trim() === "") {
        throw new Error("open human gate references an object without a notion page");
      }
      delete response.objectType;
      delete response.objectId;
      return Object.assign(response, {
        otherOptions,
        notionUrl: notionPageUrl(pageId),
      });
    });
    const activeRequirements = requirements.rows.map((row) => {
      const phase = String(row.phase);
      return {
        id: String(row.id),
        title: String(row.title),
        storyId: String(row.story_id),
        phase,
        workingOn: String(row.working_on),
        activeFor: formatWaitingDuration((this.now() - Number(row.phase_started_at)) / 60_000),
        latestProgress: `${phase} started`,
        notionUrl: notionPageUrl(row.notion_page_id as string | null),
      };
    });
    return {
      status: "success",
      pendingResponseState: pendingResponses.length === 0 ? "no_pending_responses" : "available",
      pendingResponses,
      activeRequirementState: activeRequirements.length === 0 ? "no_active_requirements" : "available",
      activeRequirements,
    };
  }

  /**
   * A human gate names the object it is about by type and id; the Notion page
   * id lives with that object, never on the gate itself. Returning null keeps
   * the failure decision with the caller instead of inventing a link.
   */
  private async resolveGatePageIds(rows: Row[]): Promise<Map<string, string | null>> {
    const tables: Record<string, string> = { requirement: "requirements", epic: "epics", story: "stories" };
    const pageIds = new Map<string, string | null>();
    await Promise.all(rows.map(async (row) => {
      const table = tables[String(row.objectType)];
      // The table name comes from a closed map, never from the stored value.
      const resolved = table
        ? (await this.client.execute({
          sql: `SELECT notion_page_id FROM ${table} WHERE id = ?`,
          args: [String(row.objectId)],
        })).rows[0]
        : undefined;
      pageIds.set(String(row.id), resolved ? String(resolved.notion_page_id) : null);
    }));
    return pageIds;
  }
}
