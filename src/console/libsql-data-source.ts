import type { Client, Row } from "@libsql/client";
import type { CanonicalEvent } from "../observability/canonical-log.js";
import { ProjectionRegistry } from "../observability/projections/registry.js";
import { renderTraceHtml } from "../observability/projections/trace-html.js";
import { traceProjection } from "../observability/projections/units.js";
import { summarizeFootprintDeviation } from "../orchestrator/footprint-deviation.js";
import { LibsqlDailyCostReadPort, type DailyCostReadResult, type DailyCostSelection, type DailyCostTimeZoneOption } from "./daily-costs.js";
import { LibsqlRequirementCostReadPort } from "../persistence/requirement-cost-ledger.js";
import type { RequirementCostSnapshot } from "../persistence/requirement-cost-ledger.js";
import {
  LibsqlRequirementCostLimitReadPort,
  LibsqlRequirementCostLimitStore,
  type OverLimitRequirementSnapshot,
  type RequirementCostWithLimitSnapshot,
} from "../persistence/requirement-cost-limit.js";
import type { RequirementSummaryRow } from "./requirement-detail-page.js";
import type { ConsoleDataSource } from "./server.js";

function plain(row: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row));
}

export class LibsqlConsoleDataSource implements ConsoleDataSource {
  private readonly dailyCostPort: LibsqlDailyCostReadPort;
  private readonly requirementCostPort: LibsqlRequirementCostReadPort;
  readonly requirementCostLimitStore: LibsqlRequirementCostLimitStore;
  private readonly requirementCostLimitPort: LibsqlRequirementCostLimitReadPort;

  constructor(
    private readonly client: Client,
    private readonly nodeSnapshot: () => Promise<unknown[]>,
    /** The fleet-scale projection, when one is running. It is read as a value,
     * never recomputed here: the whole point of the cascade is that the widest
     * view costs one read rather than a walk over every event. */
    private readonly fleet?: () => unknown,
  ) {
    this.dailyCostPort = new LibsqlDailyCostReadPort(client);
    this.requirementCostPort = new LibsqlRequirementCostReadPort(client);
    this.requirementCostLimitStore = new LibsqlRequirementCostLimitStore(client);
    this.requirementCostLimitPort = new LibsqlRequirementCostLimitReadPort(
      client,
      this.requirementCostPort,
      this.requirementCostLimitStore,
    );
  }

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

  /** The selectable natural-day zones, straight from the runtime's IANA catalog. */
  dailyCostTimeZones(): Promise<readonly DailyCostTimeZoneOption[]> {
    return this.dailyCostPort.listTimeZones();
  }

  /** One snapshot of daily costs for a selection, read from `cost_entries` and `turn_usage`. */
  dailyCosts(selection: DailyCostSelection): Promise<DailyCostReadResult> {
    return this.dailyCostPort.readDailyCosts(selection);
  }

  /** The requirements a person may open, newest first. */
  async requirements(): Promise<readonly RequirementSummaryRow[]> {
    return (await this.client.execute(
      "SELECT id, title, state FROM requirements ORDER BY updated_at DESC",
    )).rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      state: String(row.state),
    }));
  }

  /**
   * One requirement's whole-history cost, read from the frozen ledger. An id
   * that names no requirement is null rather than a page of zeroes, so the
   * route can answer "not found" instead of inventing a total.
   */
  async requirementCost(requirementId: string): Promise<RequirementCostSnapshot | null> {
    const exists = await this.client.execute({
      sql: "SELECT 1 FROM requirements WHERE id = ?",
      args: [requirementId],
    });
    if (exists.rows.length === 0) return null;
    return this.requirementCostPort.readRequirementCost(requirementId);
  }

  /** The same whole-history read plus the requirement's configured limit. */
  requirementCostWithLimit(requirementId: string): Promise<RequirementCostWithLimitSnapshot | null> {
    return this.requirementCostLimitPort.readRequirementCostWithLimit(requirementId);
  }

  /** Every requirement already over its own limit, for the overview summary. */
  overLimitRequirements(): Promise<readonly OverLimitRequirementSnapshot[]> {
    return this.requirementCostLimitPort.listOverLimitRequirements();
  }

  async config(): Promise<unknown[]> {
    return (await this.client.execute(
      "SELECT scope_id, key, value_json, version, updated_by, updated_at FROM config_entries ORDER BY scope_id, key",
    )).rows.map((row) => Object.assign(plain(row), {
      value: JSON.parse(String(row.value_json)),
    }));
  }
}
