import type { Client, Row } from "@libsql/client";
import type { CanonicalEvent } from "../observability/canonical-log.js";
import { ProjectionRegistry } from "../observability/projections/registry.js";
import { renderTraceHtml } from "../observability/projections/trace-html.js";
import { traceProjection } from "../observability/projections/units.js";
import { summarizeFootprintDeviation } from "../orchestrator/footprint-deviation.js";
import {
  projectTaskExecutionDetail,
  type TaskExecutionDetail,
  type TaskExecutionOutput,
  type TaskRoundObservation,
} from "./task-execution-detail.js";
import type { ConsoleDataSource } from "./server.js";

function plain(row: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row));
}

interface StoredVerification {
  verdict: "accepted" | "rejected" | "inconclusive";
  reasons: string[];
  validationErrors: string[];
}

/** The verifier's own account, when it wrote structured JSON; a verifier that
 * never reached a document recorded no structured reason. */
function readVerification(body: string): { reasons: string[]; validationErrors: string[] } {
  let parsed: { reasons?: Array<{ reason?: unknown }>; validationErrors?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { reasons: [], validationErrors: [] };
  }
  const reasons = (parsed.reasons ?? [])
    .map((item) => (typeof item?.reason === "string" ? item.reason : ""))
    .filter((reason) => reason !== "");
  const validationErrors = Array.isArray(parsed.validationErrors)
    ? parsed.validationErrors.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
  return { reasons, validationErrors };
}

/**
 * A failed round must show the reason the store holds, never a placeholder.
 * The verifier's own wording is preferred; a phase run's failure text is the
 * fallback. When neither exists the snapshot is refused rather than dressed up.
 */
function toVerification(
  stored: StoredVerification,
  phaseFailure: string | undefined,
): NonNullable<TaskRoundObservation["verification"]> {
  const detail = stored.reasons.join("; ") || stored.validationErrors.join("; ");
  if (stored.verdict === "accepted") {
    return { verdict: "accepted", result: detail || stored.verdict };
  }
  const failureReason = detail || phaseFailure;
  if (failureReason === undefined || failureReason === "") {
    throw new Error(`verification round was ${stored.verdict} without a persisted reason`);
  }
  return { verdict: stored.verdict, result: failureReason, failureReason };
}

export class LibsqlConsoleDataSource implements ConsoleDataSource {
  constructor(
    private readonly client: Client,
    private readonly nodeSnapshot: () => Promise<unknown[]>,
    /** The fleet-scale projection, when one is running. It is read as a value,
     * never recomputed here: the whole point of the cascade is that the widest
     * view costs one read rather than a walk over every event. */
    private readonly fleet?: () => unknown,
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
      ...(this.fleet ? { fleet: this.fleet() } : {}),
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

  /**
   * The queue as the central store holds it: cards that may be dispatched,
   * cards a worker is running right now, and the provider capacity in use.
   *
   * There is no broker to look at. Ownership is the card lease, throttling is
   * the provider slot, and both are rows here -- a dashboard over a queue
   * server would be a second account of the same facts, free to disagree.
   */
  async queue(): Promise<unknown> {
    const now = Date.now();
    const [waiting, running, slots] = await Promise.all([
      this.client.execute({
        sql: `SELECT s.id, s.title, s.state, s.phase, s.priority, s.repo, s.updated_at
                FROM stories s
                LEFT JOIN leases l ON l.card_id = s.id AND l.expires_at > ?
               WHERE s.state IN ('QUEUED','SHAPE','DESIGN','SPECIFY','CODE','VERIFY','MERGE','REGRESSION_FIX')
                 AND l.card_id IS NULL
               ORDER BY s.priority ASC, s.created_at ASC`,
        args: [now],
      }),
      this.client.execute({
        sql: `SELECT l.card_id, l.holder, l.fence, l.acquired_at, l.expires_at, s.state, s.phase, s.title
                FROM leases l LEFT JOIN stories s ON s.id = l.card_id
               WHERE l.expires_at > ? ORDER BY l.acquired_at`,
        args: [now],
      }),
      this.client.execute({
        sql: `SELECT provider, COUNT(*) AS held, MIN(expires_at) AS next_expiry
                FROM provider_slots WHERE expires_at > ? GROUP BY provider ORDER BY provider`,
        args: [now],
      }),
    ]);
    return {
      waiting: waiting.rows.map(plain),
      running: running.rows.map(plain),
      providerSlots: slots.rows.map(plain),
    };
  }

  async config(): Promise<unknown[]> {
    return (await this.client.execute(
      "SELECT scope_id, key, value_json, version, updated_by, updated_at FROM config_entries ORDER BY scope_id, key",
    )).rows.map((row) => Object.assign(plain(row), {
      value: JSON.parse(String(row.value_json)),
    }));
  }

  /**
   * One task's whole execution history, from the central store alone. Every
   * round the card has is grouped once, oldest first, with the phase runs as
   * its process, the artifacts as its outputs and the verification (or latest
   * progress) as its current result. The query is scoped by card id, so a
   * neighbouring task's rows can never enter the snapshot.
   */
  async taskExecutionDetail(taskId: string): Promise<TaskExecutionDetail | null> {
    const story = (await this.client.execute({
      sql: "SELECT id, title FROM stories WHERE id = ?",
      args: [taskId],
    })).rows[0];
    if (story === undefined) return null;

    const [runs, artifacts, verifications] = await Promise.all([
      this.client.execute({
        sql: `SELECT run_id, phase, round, status, failure, started_at, ended_at
                FROM phase_runs WHERE card_id = ? ORDER BY round, started_at, run_id`,
        args: [taskId],
      }),
      this.client.execute({
        sql: `SELECT run_id, phase, round, kind, body, created_at
                FROM phase_artifacts WHERE card_id = ? ORDER BY created_at, id`,
        args: [taskId],
      }),
      this.client.execute({
        sql: "SELECT round, verdict FROM verify_records WHERE card_id = ? ORDER BY round",
        args: [taskId],
      }),
    ]);

    const outputsByRun = new Map<string, TaskExecutionOutput[]>();
    for (const row of artifacts.rows) {
      const runId = String(row.run_id);
      const outputs = outputsByRun.get(runId) ?? [];
      outputs.push({
        phase: String(row.phase),
        kind: String(row.kind),
        content: String(row.body),
        createdAt: Number(row.created_at),
      });
      outputsByRun.set(runId, outputs);
    }

    const failureByRound = new Map<number, string>();
    for (const row of runs.rows) {
      if (String(row.status) !== "failed" || row.failure === null) continue;
      failureByRound.set(Number(row.round), String(row.failure));
    }

    const verificationByRound = new Map<number, StoredVerification>();
    for (const row of verifications.rows) {
      const round = Number(row.round);
      const body = artifacts.rows
        .findLast((artifact) => Number(artifact.round) === round && String(artifact.kind) === "verification")?.body;
      const parsed = body === undefined ? { reasons: [], validationErrors: [] } : readVerification(String(body));
      verificationByRound.set(round, {
        verdict: String(row.verdict) as StoredVerification["verdict"],
        reasons: parsed.reasons,
        validationErrors: parsed.validationErrors,
      });
    }

    const observations: TaskRoundObservation[] = runs.rows.map((row) => {
      const round = Number(row.round);
      const outputs = outputsByRun.get(String(row.run_id)) ?? [];
      const verification = verificationByRound.get(round);
      const failure = failureByRound.get(round);
      const observation: TaskRoundObservation = {
        round,
        phase: String(row.phase),
        runStatus: String(row.status) as TaskRoundObservation["runStatus"],
        startedAt: Number(row.started_at),
        progress: outputs.at(-1)?.content ?? "",
        outputs,
      };
      if (row.ended_at !== null) observation.endedAt = Number(row.ended_at);
      if (failure !== undefined) observation.failureReason = failure;
      if (verification !== undefined) observation.verification = toVerification(verification, failure);
      return observation;
    });

    return projectTaskExecutionDetail({
      taskId,
      taskName: String(story.title),
      observedAt: Date.now(),
      observations,
    });
  }
}
