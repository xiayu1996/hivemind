import type { Client, Row } from "@libsql/client";
import type { ErrorClass } from "./classify.js";
import {
  closedHealth,
  onProviderFailure,
  onProviderSuccess,
  type BreakerPolicy,
  type BreakerState,
  type ProviderHealth,
} from "./circuit-breaker.js";

interface StoredHealth extends ProviderHealth {
  lastProbeAt: number | null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toHealth(row: Row): StoredHealth {
  return {
    provider: String(row.provider),
    state: String(row.state) as BreakerState,
    consecutiveFailures: Number(row.consecutive_failures),
    openedAt: optionalNumber(row.opened_at),
    retryAt: optionalNumber(row.retry_at),
    needsHuman: Number(row.needs_human) === 1,
    lastErrorClass: optionalString(row.last_error_class) as ErrorClass | null,
    lastError: optionalString(row.last_error),
    lastProbeAt: optionalNumber(row.last_probe_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Provider health in the central database. One account per vendor means the
 * usage window and the concurrency limit belong to the account, not to a host,
 * so a breaker one machine opens has to be visible to every other machine.
 */
export class LibsqlProviderHealthStore {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  async snapshot(): Promise<Map<string, StoredHealth>> {
    const rows = (await this.client.execute("SELECT * FROM provider_health ORDER BY provider")).rows;
    return new Map(rows.map((row) => [String(row.provider), toHealth(row)]));
  }

  async get(provider: string): Promise<StoredHealth | null> {
    const row = (await this.client.execute({
      sql: "SELECT * FROM provider_health WHERE provider = ?",
      args: [provider],
    })).rows[0];
    return row ? toHealth(row) : null;
  }

  private async current(provider: string, at: number): Promise<StoredHealth> {
    return (await this.get(provider)) ?? { ...closedHealth(provider, at), lastProbeAt: null };
  }

  async recordFailure(provider: string, errorMessage: string, policy: BreakerPolicy): Promise<ProviderHealth> {
    const at = this.now();
    const before = await this.current(provider, at);
    return this.persist(before, onProviderFailure(before, { at, errorMessage, policy }), before.lastProbeAt);
  }

  async recordSuccess(provider: string): Promise<ProviderHealth> {
    const at = this.now();
    const before = await this.current(provider, at);
    return this.persist(before, onProviderSuccess(before, at), before.lastProbeAt);
  }

  /** A probe result, stamped so an operator can see the breaker is being tried
   * rather than merely stuck. */
  async recordProbe(provider: string, ok: boolean, errorMessage = "probe failed", policy?: BreakerPolicy): Promise<ProviderHealth> {
    const at = this.now();
    const before = await this.current(provider, at);
    const after = ok
      ? onProviderSuccess(before, at)
      : policy
        ? onProviderFailure(before, { at, errorMessage, policy })
        : { ...before, updatedAt: at };
    return this.persist(before, after, at);
  }

  private async persist(
    before: ProviderHealth,
    after: ProviderHealth,
    lastProbeAt: number | null,
  ): Promise<ProviderHealth> {
    const statements: Array<{ sql: string; args: Array<string | number | null> }> = [{
      sql: `INSERT INTO provider_health
              (provider, state, consecutive_failures, opened_at, retry_at, needs_human,
               last_error_class, last_error, last_probe_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET
              state = excluded.state,
              consecutive_failures = excluded.consecutive_failures,
              opened_at = excluded.opened_at,
              retry_at = excluded.retry_at,
              needs_human = excluded.needs_human,
              last_error_class = excluded.last_error_class,
              last_error = excluded.last_error,
              last_probe_at = excluded.last_probe_at,
              updated_at = excluded.updated_at`,
      args: [
        after.provider,
        after.state,
        after.consecutiveFailures,
        after.openedAt,
        after.retryAt,
        after.needsHuman ? 1 : 0,
        after.lastErrorClass,
        after.lastError,
        lastProbeAt,
        after.updatedAt,
      ],
    }];
    // Only the transition is an event; a provider failing repeatedly while
    // already open is not news, and would drown the log during an outage.
    if (before.state !== after.state) {
      const runId = `provider:${after.provider}`;
      statements.push({
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                      NULL, NULL, ?, ?, ?)`,
        args: [
          runId,
          runId,
          after.state === "closed" ? "provider.closed" : "provider.opened",
          after.updatedAt,
          JSON.stringify({
            provider: after.provider,
            state: after.state,
            errorClass: after.lastErrorClass,
            retryAt: after.retryAt,
            needsHuman: after.needsHuman,
          }),
        ],
      });
    }
    await this.client.batch(statements, "write");
    return after;
  }
}
