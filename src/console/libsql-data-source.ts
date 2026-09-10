import type { Client, Row } from "@libsql/client";
import type { CanonicalEvent } from "../observability/canonical-log.js";
import { ProjectionRegistry } from "../observability/projections/registry.js";
import { renderTraceHtml } from "../observability/projections/trace-html.js";
import { traceProjection } from "../observability/projections/units.js";
import { summarizeFootprintDeviation } from "../orchestrator/footprint-deviation.js";
import type { ConsoleDataSource } from "./server.js";
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
      this.client.execute(`SELECT id, required_action AS requiredAction, phase AS whereThisArose,
                                  recommended_choice AS recommendedChoice,
                                  recommendation_reason AS recommendationReason,
                                  other_options AS otherOptions,
                                  confirmation_reason AS confirmationReason,
                                  navigation_target AS navigationTarget
                             FROM human_gates
                            WHERE state = 'open'
                            ORDER BY priority, created_at, id`),
      this.client.execute(`SELECT r.id AS id, r.title AS title, s.id AS story_id,
                                  COALESCE(s.phase, s.state) AS phase, s.title AS working_on,
                                  s.phase_started_at
                             FROM requirements r
                             JOIN epics e ON e.requirement_id = r.id
                             JOIN stories s ON s.epic_id = e.id
                            WHERE r.state = 'EXECUTING'
                              AND s.state IN ('QUEUED', 'DESIGN', 'CODE', 'VERIFY', 'MERGE', 'REGRESSION_FIX')
                              AND s.phase_started_at IS NOT NULL
                            ORDER BY r.updated_at DESC, r.id`),
    ]);
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
      return Object.assign(response, { otherOptions });
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
}
