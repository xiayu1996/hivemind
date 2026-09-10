import type { Client, Row } from "@libsql/client";
import type { CanonicalEvent } from "../observability/canonical-log.js";
import { ProjectionRegistry } from "../observability/projections/registry.js";
import { renderTraceHtml } from "../observability/projections/trace-html.js";
import { traceProjection } from "../observability/projections/units.js";
import { summarizeFootprintDeviation } from "../orchestrator/footprint-deviation.js";
import type { ConsoleDataSource } from "./server.js";

function plain(row: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row));
}

export class LibsqlConsoleDataSource implements ConsoleDataSource {
  constructor(
    private readonly client: Client,
    private readonly nodeSnapshot: () => Promise<unknown[]>,
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
      const events = eventRows.flatMap((event) => {
        try {
          return [{
            runId: String(event.run_id),
            type: String(event.type),
            seq: Number(event.seq),
            time: Number(event.ts),
            data: JSON.parse(String(event.data)),
          }];
        } catch {
          return [];
        }
      });
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

  /** A compact, dedicated read path for the console home page. */
  async overview(): Promise<unknown> {
    const questions: Array<Record<string, unknown>> = [];
    const clarificationRows = (await this.client.execute(
      `SELECT r.id, r.title, r.state, r.updated_at, c.round, c.questions
         FROM requirements r JOIN requirement_clarify_rounds c ON c.requirement_id = r.id
        WHERE c.answered_at IS NULL AND r.state NOT IN ('DONE', 'FAILED', 'HUMAN_PARKED')
        ORDER BY r.updated_at DESC, r.id, c.round`,
    )).rows;
    for (const row of clarificationRows) {
      const question = firstQuestion(row.questions);
      if (question) questions.push({
        id: `${String(row.id)}:clarify:${Number(row.round)}`,
        title: String(row.title), state: String(row.state), summary: question,
        updatedAt: Number(row.updated_at), taskPath: "/tasks",
      });
    }

    const blockedRows = (await this.client.execute(
      `SELECT id, title, state, updated_at FROM requirements
        WHERE stop_reason = 'blocking_question' AND state NOT IN ('DONE', 'FAILED', 'HUMAN_PARKED')
       UNION ALL
       SELECT id, title, state, updated_at FROM stories
        WHERE stop_reason = 'blocking_question' AND state NOT IN ('DELIVERED', 'FAILED', 'HUMAN_PARKED')
       ORDER BY id`,
    )).rows;
    for (const row of blockedRows) questions.push({
      id: `${String(row.id)}:blocked`, title: String(row.title), state: String(row.state),
      summary: "blocking_question", updatedAt: Number(row.updated_at), taskPath: "/tasks",
    });

    const activeRows = (await this.client.execute(
      `SELECT id, title, state, 'Last updated' AS summary, updated_at FROM requirements
        WHERE state NOT IN ('DONE', 'FAILED', 'HUMAN_PARKED') AND stop_reason IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM requirement_clarify_rounds c
             WHERE c.requirement_id = requirements.id AND c.answered_at IS NULL
          )
       UNION ALL
       SELECT id, title, state, 'Last updated' AS summary, updated_at FROM stories
        WHERE state NOT IN ('DELIVERED', 'FAILED', 'HUMAN_PARKED', 'NEEDS_INPUT') AND stop_reason IS NULL
       ORDER BY updated_at DESC, id`,
    )).rows;
    const active = activeRows.map((row) => ({
      id: String(row.id), title: String(row.title), state: String(row.state),
      summary: String(row.summary), updatedAt: Number(row.updated_at), taskPath: "/tasks",
    }));

    const eventRows = (await this.client.execute(
      `SELECT e.card_id, e.type, e.ts, e.data, s.title
         FROM event_log e JOIN stories s ON s.id = e.card_id
        WHERE e.type IN ('story.transition', 'story.delivered')
        ORDER BY e.ts DESC, e.run_id, e.seq`,
    )).rows;
    const events = eventRows.flatMap((row) => {
      const timestamp = Number(row.ts);
      if (!Number.isFinite(timestamp) || timestamp <= 0) return [];
      const state = transitionedStoryState(String(row.type), row.data);
      if (!state) return [];
      return [{
        storyId: String(row.card_id), title: String(row.title), state, timestamp,
        summary: state === "FAILED" ? failureSummary(row.data) : "Delivered",
        taskPath: "/tasks",
      }];
    });

    return { questions, active, events };
  }
}

function transitionedStoryState(type: string, value: unknown): "DELIVERED" | "FAILED" | null {
  if (type === "story.delivered") return "DELIVERED";
  try {
    const state = (JSON.parse(String(value)) as { to?: unknown }).to;
    return state === "DELIVERED" || state === "FAILED" ? state : null;
  } catch {
    return null;
  }
}

function failureSummary(value: unknown): string {
  try {
    const reason = (JSON.parse(String(value)) as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.trim() !== "" ? reason : "Failed";
  } catch {
    return "Failed";
  }
}

function firstQuestion(value: unknown): string | null {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return null;
    const question = parsed[0];
    if (!question || typeof question !== "object" || typeof (question as { question?: unknown }).question !== "string") return null;
    const text = (question as { question: string }).question.trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}
