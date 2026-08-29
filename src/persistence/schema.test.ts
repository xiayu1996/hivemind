import { describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { isMainModule, migrate } from "./migrate.js";
import * as schema from "./schema.js";

async function freshDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  return client;
}

const now = () => Date.now();

describe("migrations", () => {
  it("recognises a Windows entry point without hand-building a file URL", () => {
    const entry = resolve("src/persistence/migrate.ts");
    expect(isMainModule(pathToFileURL(entry).href, entry)).toBe(true);
  });

  it("applies on an empty database", async () => {
    const client = createClient({ url: ":memory:" });
    const ran = await migrate(client);
    expect(ran).toContain("0001_init.sql");
    client.close();
  });

  it("is idempotent: a second run applies nothing", async () => {
    const client = await freshDb();
    const again = await migrate(client);
    expect(again).toEqual([]);
    client.close();
  });

  it("records applied migrations", async () => {
    const client = await freshDb();
    const rows = (await client.execute("SELECT name FROM schema_migrations")).rows;
    expect(rows.length).toBeGreaterThan(0);
    client.close();
  });
});

describe("drizzle schema matches the migrations", () => {
  it("declares no table or column the database does not have", async () => {
    const client = await freshDb();
    const tables = new Set(
      (await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )).rows.map((r) => String(r.name)),
    );

    const drift: string[] = [];
    for (const value of Object.values(schema)) {
      let config;
      try {
        config = getTableConfig(value as never);
      } catch {
        continue; // not a table export
      }
      if (!tables.has(config.name)) {
        drift.push(`missing table: ${config.name}`);
        continue;
      }
      const actual = new Set(
        (await client.execute(`PRAGMA table_info(${config.name})`)).rows.map((r) => String(r.name)),
      );
      for (const column of config.columns) {
        if (!actual.has(column.name)) drift.push(`missing column: ${config.name}.${column.name}`);
      }
    }

    expect(drift).toEqual([]);
    client.close();
  });
});

describe("builder and verifier separation", () => {
  const insertVerify = (client: Client, code: string, verify: string, round = 1) =>
    client.execute({
      sql: `INSERT INTO verify_records
              (card_id, round, code_session_id, verify_session_id, verdict, created_at)
            VALUES (?, ?, ?, ?, 'accepted', ?)`,
      args: ["card-1", round, code, verify, now()],
    });

  it("accepts a verdict from a different session", async () => {
    const client = await freshDb();
    await expect(insertVerify(client, "sess-code", "sess-verify")).resolves.toBeDefined();
    client.close();
  });

  it("rejects a verdict written from the coding session itself", async () => {
    const client = await freshDb();
    await expect(insertVerify(client, "sess-same", "sess-same")).rejects.toThrow(/CHECK/i);
    client.close();
  });

  it("rejects a second verdict for the same card and round", async () => {
    const client = await freshDb();
    await insertVerify(client, "sess-code", "sess-verify");
    await expect(insertVerify(client, "sess-code2", "sess-verify2")).rejects.toThrow(/UNIQUE/i);
    client.close();
  });
});

describe("state and stop-reason constraints", () => {
  const insertStory = (client: Client, state: string, stopReason: string | null = null) =>
    client.execute({
      sql: `INSERT INTO stories (id, notion_page_id, title, state, stop_reason, created_at, updated_at)
            VALUES (?, ?, 'x', ?, ?, ?, ?)`,
      args: [`s-${state}-${stopReason}`, `p-${state}-${stopReason}`, state, stopReason, now(), now()],
    });

  it("accepts declared states", async () => {
    const client = await freshDb();
    for (const state of ["QUEUED", "CODE", "HUMAN_PARKED", "DELIVERED"]) {
      await expect(insertStory(client, state)).resolves.toBeDefined();
    }
    client.close();
  });

  it("rejects an undeclared state", async () => {
    const client = await freshDb();
    await expect(insertStory(client, "WHATEVER")).rejects.toThrow(/CHECK/i);
    client.close();
  });

  it("allows only the three real stop reasons", async () => {
    const client = await freshDb();
    await expect(insertStory(client, "FAILED", "retry_limit_exceeded")).resolves.toBeDefined();
    await expect(insertStory(client, "FAILED", "gave_up")).rejects.toThrow(/CHECK/i);
    client.close();
  });
});

describe("outbox idempotency", () => {
  it("deduplicates by target and payload hash without conflating different pages", async () => {
    const client = await freshDb();
    const insert = (target: string) =>
      client.execute({
        sql: `INSERT INTO notion_outbox (operation, target, payload, payload_hash, created_at)
              VALUES ('append_blocks', ?, '{}', 'hash-1', ?)`,
        args: [target, now()],
      });
    await insert("page-1");
    await expect(insert("page-1")).rejects.toThrow(/UNIQUE/i);
    await expect(insert("page-2")).resolves.toBeDefined();
    client.close();
  });
});

describe("event log ordering", () => {
  it("rejects a duplicate (run_id, seq)", async () => {
    const client = await freshDb();
    const insert = (seq: number) =>
      client.execute({
        sql: "INSERT INTO event_log (run_id, seq, type, ts, data) VALUES ('run-1', ?, 'turn_start', ?, '{}')",
        args: [seq, now()],
      });
    await insert(1);
    await insert(2);
    await expect(insert(1)).rejects.toThrow(/UNIQUE/i);
    client.close();
  });
});
