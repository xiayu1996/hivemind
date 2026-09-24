import type { Client } from "@libsql/client";
import { z } from "zod";
import { CONFIG_KEYS, type ConfigKey } from "../config/registry.js";
import type { ConfigStore } from "../config/store.js";

export interface ConfigKeyDescription {
  key: string;
  value: unknown;
  default: unknown;
  /** Shown, never written from here. */
  readOnly: boolean;
  scope: string;
  reload: string;
  description: string;
  dangerous: boolean;
  overridden: boolean;
  /** JSON Schema for the value, so a form can be generated rather than hand-written. */
  schema: unknown;
}

export class ReadOnlyConfigKeyError extends Error {
  constructor(key: string) {
    super(`${key} is read-only from the console; change it in the repository`);
    this.name = "ReadOnlyConfigKeyError";
  }
}

/**
 * Keys the console shows but never writes.
 *
 * The console exists so that wording and model choices can change without a
 * release -- those are data. What an agent may touch is not: the tool surface,
 * the skills and the MCP servers are the physical boundary the deterministic
 * exits are argued against, and widening one from a web form leaves no diff to
 * review and no test to fail. They move through the repository like code.
 */
export const CONSOLE_READ_ONLY_KEYS: readonly string[] = [
  "agent.purposeTools",
  "agent.purposeSkills",
  "agent.purposeMcp",
];

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
      readOnly: CONSOLE_READ_ONLY_KEYS.includes(key),
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
    if (CONSOLE_READ_ONLY_KEYS.includes(key)) throw new ReadOnlyConfigKeyError(key);
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
