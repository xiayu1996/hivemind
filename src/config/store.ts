import type { Client } from "@libsql/client";
import { CONFIG_KEYS, CONFIG_KEY_NAMES, type ConfigKey, type ConfigValue } from "./registry.js";

export interface ConfigChange {
  key: ConfigKey;
  version: number;
  previous: unknown;
  next: unknown;
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

  private constructor(private readonly client: Client) {}

  static async load(client: Client): Promise<ConfigStore> {
    const store = new ConfigStore(client);
    await store.reload();
    return store;
  }

  /** Sum of per-key versions: changes whenever any key changes. */
  get version(): number {
    return this.#version;
  }

  async reload(): Promise<void> {
    const rows = (await this.client.execute("SELECT key, value_json, version FROM config_entries")).rows;
    const overlay = new Map<ConfigKey, unknown>();
    let version = 0;

    for (const row of rows) {
      const key = String(row.key);
      if (!isConfigKey(key)) continue; // a key retired in code stays in the table but is ignored
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
    const now = Date.now();
    const current = (await this.client.execute({
      sql: "SELECT version FROM config_entries WHERE key = ?",
      args: [key],
    })).rows[0];
    const version = current ? Number(current.version) + 1 : 1;
    const valueJson = JSON.stringify(parsed.data);

    await this.client.batch([
      {
        sql: `INSERT INTO config_entries (key, value_json, version, updated_by, updated_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                version    = excluded.version,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at`,
        args: [key, valueJson, version, updatedBy, now],
      },
      {
        sql: `INSERT INTO config_history (key, version, value_json, updated_by, ts)
              VALUES (?, ?, ?, ?, ?)`,
        args: [key, version, valueJson, updatedBy, now],
      },
    ], "write");

    await this.reload();
    return { key, version, previous, next: parsed.data };
  }

  /** Restores the value a key held at a given history version. */
  async rollback(key: string, toVersion: number, updatedBy: string): Promise<ConfigChange> {
    if (!isConfigKey(key)) throw new UnknownConfigKeyError(key);
    const row = (await this.client.execute({
      sql: "SELECT value_json FROM config_history WHERE key = ? AND version = ?",
      args: [key, toVersion],
    })).rows[0];
    if (!row) throw new Error(`no history for ${key} at version ${toVersion}`);
    return this.set(key, JSON.parse(String(row.value_json)), updatedBy);
  }

  async history(key: string): Promise<Array<{ version: number; value: unknown; updatedBy: string; ts: number }>> {
    const rows = (await this.client.execute({
      sql: "SELECT version, value_json, updated_by, ts FROM config_history WHERE key = ? ORDER BY version DESC",
      args: [key],
    })).rows;
    return rows.map((r) => ({
      version: Number(r.version),
      value: JSON.parse(String(r.value_json)),
      updatedBy: String(r.updated_by),
      ts: Number(r.ts),
    }));
  }
}

function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(CONFIG_KEYS, key);
}
