import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

export type Database = LibSQLDatabase<typeof schema>;

export interface OpenedDatabase {
  db: Database;
  client: Client;
  close(): void;
}

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Opens (creating when absent) the database at `path` and brings it to the
 * current schema. `":memory:"` gives a private in-memory database for tests.
 *
 * drizzle's migrator only compares the timestamp of the last applied
 * migration, never the content. Before the first real deployment the initial
 * migration is rewritten in place, so a database built from an older version
 * of it would be taken as current while still enforcing the old constraints.
 * The stored hash of every applied migration is therefore compared with the
 * file, and a mismatch refuses to start.
 */
export async function openDatabase(path: string): Promise<OpenedDatabase> {
  let url = ":memory:";
  if (path !== ":memory:") {
    const absolute = isAbsolute(path) ? path : resolve(path);
    await mkdir(dirname(absolute), { recursive: true });
    url = `file:${absolute}`;
  }
  const client = createClient({ url });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA busy_timeout = 5000");
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema });
  await assertAppliedMigrationsUnchanged(client);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, client, close: () => client.close() };
}

async function assertAppliedMigrationsUnchanged(client: Client): Promise<void> {
  const table = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'");
  if (table.rows.length === 0) return;
  const applied = await client.execute("SELECT hash, created_at FROM __drizzle_migrations");
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  for (const row of applied.rows) {
    const createdAt = Number(row.created_at);
    const file = files.find((migration) => migration.folderMillis === createdAt);
    if (file === undefined || file.hash !== String(row.hash)) {
      throw new Error(
        "this database was built from a migration that no longer exists in this form; before the first deployment migrations are rewritten in place, so delete the database file and start again",
      );
    }
  }
}
