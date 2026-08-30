import type { Client } from "@libsql/client";
import { z } from "zod";
import { CONFIG_KEYS, type ConfigKey } from "../config/registry.js";
import type { ConfigStore } from "../config/store.js";

export interface ConfigKeyDescription {
  key: string;
  value: unknown;
  default: unknown;
  scope: string;
  reload: string;
  description: string;
  dangerous: boolean;
  overridden: boolean;
  /** JSON Schema for the value, so a form can be generated rather than hand-written. */
  schema: unknown;
}

export class DangerousConfigChangeError extends Error {
  constructor(key: string) {
    super(`${key} is a high-risk key: resend the change with confirm set`);
    this.name = "DangerousConfigChangeError";
  }
}

/**
 * The console's only write surface. Everything it can do is already expressible
 * against the registry, so the form is generated from the same schema that
 * validates the value: a console that could set a key the registry rejects
 * would be a second, weaker validator.
 */
export class ConsoleConfigWriter {
  constructor(
    private readonly config: ConfigStore,
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  async describe(): Promise<ConfigKeyDescription[]> {
    await this.config.reload();
    return Object.entries(CONFIG_KEYS).map(([key, definition]) => ({
      key,
      value: this.config.get(key as ConfigKey),
      default: definition.default,
      scope: definition.scope,
      reload: definition.reload,
      description: definition.description,
      dangerous: definition.dangerous === true,
      overridden: this.config.isOverridden(key as ConfigKey),
      schema: z.toJSONSchema(definition.schema, { io: "input", unrepresentable: "any" }),
    }));
  }

  async apply(input: { key: string; value: unknown; updatedBy: string; confirm?: boolean }): Promise<unknown> {
    this.requireConfirmation(input.key, input.confirm === true);
    const change = await this.config.set(input.key, input.value, input.updatedBy);
    await this.record(input.key, input.updatedBy, { version: change.version, previous: change.previous, next: change.next });
    return change;
  }

  async rollback(input: { key: string; version: number; updatedBy: string; confirm?: boolean }): Promise<unknown> {
    this.requireConfirmation(input.key, input.confirm === true);
    const change = await this.config.rollback(input.key, input.version, input.updatedBy);
    await this.record(input.key, input.updatedBy, {
      version: change.version,
      previous: change.previous,
      next: change.next,
      restoredFrom: input.version,
    });
    return change;
  }

  history(key: string): Promise<unknown[]> {
    return this.config.history(key);
  }

  private requireConfirmation(key: string, confirmed: boolean): void {
    const definition = CONFIG_KEYS[key as ConfigKey];
    if (definition?.dangerous === true && !confirmed) throw new DangerousConfigChangeError(key);
  }

  /** Every change is an event, because a value that moved without a trace is
   * indistinguishable from a bug in whatever read it next. */
  private async record(key: string, updatedBy: string, data: Record<string, unknown>): Promise<void> {
    const runId = `config:${key}`;
    await this.client.execute({
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?),
                    NULL, NULL, 'config.changed', ?, ?)`,
      args: [runId, runId, this.now(), JSON.stringify({ key, updatedBy, ...data })],
    });
  }
}
