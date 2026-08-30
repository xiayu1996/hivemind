import type { Client } from "@libsql/client";
import { CONFIG_KEYS, CONFIG_KEY_NAMES, type ConfigKey, type ConfigValue } from "./registry.js";

export interface ConfigChange {
  key: ConfigKey;
  version: number;
  previous: unknown;
  next: unknown;
}

export interface ConfigScope {
  repository?: string;
}

export class ConfigValidationError extends Error {
  constructor(readonly key: string, readonly detail: string) {
    super(`invalid value for ${key}: ${detail}`);
    this.name = "ConfigValidationError";
  }
}

export class UnknownConfigKeyError extends Error {
  constructor(readonly key: string) {
    super(`unknown config key: ${key}`);
    this.name = "UnknownConfigKeyError";
  }
}

/**
 * Code defaults merged with a database overlay.
 *
 * Defaults are the fallback truth: with config_entries empty the system still
 * runs. `version` is the overlay generation, piggybacked on heartbeats so workers
 * notice a change without a second channel.
 */
export class ConfigStore {
  #overlay = new Map<ConfigKey, unknown>();
  #version = 0;

  private constructor(
    private readonly client: Client,
    private readonly scope: ConfigScope,
  ) {}

  static async load(client: Client, scope: ConfigScope = {}): Promise<ConfigStore> {
    const store = new ConfigStore(client, scope);
    await store.reload();
    return store;
  }

  /** Sum of per-key versions: changes whenever any key changes. */
  get version(): number {
    return this.#version;
  }

  async reload(): Promise<void> {
    const scopeIds = ["global", ...(this.scope.repository ? [this.scope.repository] : [])];
    const rows = (await this.client.execute({
      sql: `SELECT scope_id, key, value_json, version FROM config_entries
            WHERE scope_id IN (${scopeIds.map(() => "?").join(", ")})`,
      args: scopeIds,
    })).rows;
    const overlay = new Map<ConfigKey, unknown>();
    let version = 0;

    for (const row of rows) {
      const key = String(row.key);
      if (!isConfigKey(key) || String(row.scope_id) !== this.scopeId(key)) continue;
      const parsed = CONFIG_KEYS[key].schema.safeParse(JSON.parse(String(row.value_json)));
      if (!parsed.success) continue; // a value that no longer validates falls back to the default
      overlay.set(key, parsed.data);
      version += Number(row.version);
    }

    this.#overlay = overlay;
    this.#version = version;
  }

  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    if (this.#overlay.has(key)) return this.#overlay.get(key) as ConfigValue<K>;
    return CONFIG_KEYS[key].default as ConfigValue<K>;
  }

  /** True when the value comes from the database rather than the code default. */
  isOverridden(key: ConfigKey): boolean {
    return this.#overlay.has(key);
  }

  /** Every key with its effective value and where it came from. */
  snapshot(): Array<{ key: ConfigKey; value: unknown; overridden: boolean }> {
    return CONFIG_KEY_NAMES.map((key) => ({
      key,
      value: this.get(key),
      overridden: this.isOverridden(key),
    }));
  }

  async set(key: string, value: unknown, updatedBy: string): Promise<ConfigChange> {
    if (!isConfigKey(key)) throw new UnknownConfigKeyError(key);

    const parsed = CONFIG_KEYS[key].schema.safeParse(value);
    if (!parsed.success) {
      throw new ConfigValidationError(key, parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
    }

    const previous = this.get(key);
    const scopeId = this.scopeId(key);
    const now = Date.now();
    const current = (await this.client.execute({
      sql: "SELECT version FROM config_entries WHERE scope_id = ? AND key = ?",
      args: [scopeId, key],
    })).rows[0];
    const version = current ? Number(current.version) + 1 : 1;
    const valueJson = JSON.stringify(parsed.data);

    await this.client.batch([
      {
        sql: `INSERT INTO config_entries (scope_id, key, value_json, version, updated_by, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(scope_id, key) DO UPDATE SET
                value_json = excluded.value_json,
                version    = excluded.version,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at`,
        args: [scopeId, key, valueJson, version, updatedBy, now],
      },
      {
        sql: `INSERT INTO config_history (scope_id, key, version, value_json, updated_by, ts)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [scopeId, key, version, valueJson, updatedBy, now],
      },
    ], "write");

    await this.reload();
    return { key, version, previous, next: parsed.data };
  }

  /** Restores the value a key held at a given history version. */
  async rollback(key: string, toVersion: number, updatedBy: string): Promise<ConfigChange> {
    if (!isConfigKey(key)) throw new UnknownConfigKeyError(key);
    const row = (await this.client.execute({
      sql: "SELECT value_json FROM config_history WHERE scope_id = ? AND key = ? AND version = ?",
      args: [this.scopeId(key), key, toVersion],
    })).rows[0];
    if (!row) throw new Error(`no history for ${key} at version ${toVersion}`);
    return this.set(key, JSON.parse(String(row.value_json)), updatedBy);
  }

  async history(key: string): Promise<Array<{ version: number; value: unknown; updatedBy: string; ts: number }>> {
    if (!isConfigKey(key)) throw new UnknownConfigKeyError(key);
    const rows = (await this.client.execute({
      sql: "SELECT version, value_json, updated_by, ts FROM config_history WHERE scope_id = ? AND key = ? ORDER BY version DESC",
      args: [this.scopeId(key), key],
    })).rows;
    return rows.map((r) => ({
      version: Number(r.version),
      value: JSON.parse(String(r.value_json)),
      updatedBy: String(r.updated_by),
      ts: Number(r.ts),
    }));
  }

  private scopeId(key: ConfigKey): string {
    if (CONFIG_KEYS[key].scope !== "per-repo") return "global";
    if (!this.scope.repository) throw new Error(`repository scope is required for ${key}`);
    return this.scope.repository;
  }
}

function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(CONFIG_KEYS, key);
}
