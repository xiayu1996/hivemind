import { beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { migrate } from "../persistence/migrate.js";
import { ConfigStore, ConfigValidationError, UnknownConfigKeyError } from "./store.js";
import { CONFIG_KEYS, CONFIG_KEY_NAMES } from "./registry.js";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

describe("defaults are the fallback truth", () => {
  it("serves every key from code with an empty overlay table", async () => {
    const store = await ConfigStore.load(client);
    for (const key of CONFIG_KEY_NAMES) {
      expect(store.get(key)).toEqual(CONFIG_KEYS[key].default);
      expect(store.isOverridden(key)).toBe(false);
    }
    expect(store.version).toBe(0);
  });

  it("still serves defaults after the overlay table is wiped", async () => {
    const store = await ConfigStore.load(client);
    await store.set("retry.maxInnerLoopRounds", 12, "test");
    expect(store.get("retry.maxInnerLoopRounds")).toBe(12);

    await client.execute("DELETE FROM config_entries");
    await store.reload();

    expect(store.get("retry.maxInnerLoopRounds")).toBe(6);
    expect(store.isOverridden("retry.maxInnerLoopRounds")).toBe(false);
  });

  it("every declared default satisfies its own schema", () => {
    for (const key of CONFIG_KEY_NAMES) {
      const { schema, default: value } = CONFIG_KEYS[key];
      expect(schema.safeParse(value).success, `${key} default fails its schema`).toBe(true);
    }
  });
});

describe("overlay precedence", () => {
  it("prefers the database value over the code default", async () => {
    const store = await ConfigStore.load(client);
    await store.set("schedule.concurrencyPerHost", 4, "ryan");
    expect(store.get("schedule.concurrencyPerHost")).toBe(4);
    expect(store.isOverridden("schedule.concurrencyPerHost")).toBe(true);
  });

  it("a second store sees an overlay written by the first", async () => {
    const writer = await ConfigStore.load(client);
    await writer.set("cost.dailyUsdWarn", 55, "ryan");
    const reader = await ConfigStore.load(client);
    expect(reader.get("cost.dailyUsdWarn")).toBe(55);
  });

  it("ignores an overlay row whose value no longer validates", async () => {
    await client.execute({
      sql: "INSERT INTO config_entries (key, value_json, version, updated_by, updated_at) VALUES (?, ?, 1, 'stale', ?)",
      args: ["retry.maxInnerLoopRounds", JSON.stringify(-5), Date.now()],
    });
    const store = await ConfigStore.load(client);
    expect(store.get("retry.maxInnerLoopRounds")).toBe(6);
  });

  it("ignores a row for a key that no longer exists in code", async () => {
    await client.execute({
      sql: "INSERT INTO config_entries (key, value_json, version, updated_by, updated_at) VALUES (?, ?, 1, 'old', ?)",
      args: ["retired.key", JSON.stringify(1), Date.now()],
    });
    await expect(ConfigStore.load(client)).resolves.toBeDefined();
  });
});

describe("validation", () => {
  it("rejects a value that violates the schema", async () => {
    const store = await ConfigStore.load(client);
    await expect(store.set("retry.maxInnerLoopRounds", 0, "ryan")).rejects.toThrow(ConfigValidationError);
    await expect(store.set("retry.maxInnerLoopRounds", "six", "ryan")).rejects.toThrow(ConfigValidationError);
    expect(store.get("retry.maxInnerLoopRounds")).toBe(6);
  });

  it("rejects an unknown key", async () => {
    const store = await ConfigStore.load(client);
    await expect(store.set("nope.not.a.key", 1, "ryan")).rejects.toThrow(UnknownConfigKeyError);
  });

  it("rejects a structurally wrong value for a composite key", async () => {
    const store = await ConfigStore.load(client);
    await expect(store.set("model.failoverChain", [], "ryan")).rejects.toThrow(ConfigValidationError);
    await expect(store.set("guard.e2eHostAllowlist", "localhost", "ryan")).rejects.toThrow(ConfigValidationError);
  });
});

describe("history and rollback", () => {
  it("records every change and restores an earlier version", async () => {
    const store = await ConfigStore.load(client);
    await store.set("retry.maxInnerLoopRounds", 8, "ryan");
    await store.set("retry.maxInnerLoopRounds", 20, "ryan");
    expect(store.get("retry.maxInnerLoopRounds")).toBe(20);

    const history = await store.history("retry.maxInnerLoopRounds");
    expect(history.map((h) => h.value)).toEqual([20, 8]);

    await store.rollback("retry.maxInnerLoopRounds", 1, "ryan");
    expect(store.get("retry.maxInnerLoopRounds")).toBe(8);

    // Rollback is itself a change, so it is auditable rather than silent.
    expect((await store.history("retry.maxInnerLoopRounds")).length).toBe(3);
  });
});

describe("version signalling", () => {
  it("advances when any key changes, so a heartbeat can carry it", async () => {
    const store = await ConfigStore.load(client);
    const before = store.version;
    await store.set("pause.intake", true, "ryan");
    expect(store.version).toBeGreaterThan(before);
  });
});

describe("snapshot", () => {
  it("reports value and origin for every key", async () => {
    const store = await ConfigStore.load(client);
    await store.set("pause.intake", true, "ryan");
    const snapshot = store.snapshot();
    expect(snapshot).toHaveLength(CONFIG_KEY_NAMES.length);
    expect(snapshot.find((s) => s.key === "pause.intake")).toMatchObject({ value: true, overridden: true });
    expect(snapshot.find((s) => s.key === "cost.dailyUsdWarn")).toMatchObject({ overridden: false });
  });
});
