import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Drops whole-line `--` comments. Comment text must not survive into the split,
 * because a statement that begins with a comment would otherwise be
 * indistinguishable from a comment-only chunk and silently skipped.
 */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/**
 * Applies every migration that has not been applied yet, in filename order.
 *
 * Each file runs inside a transaction and is recorded in schema_migrations, so
 * running this against an already-migrated database is a no-op. Statements are
 * split on semicolons, which is sufficient for DDL with no semicolons inside
 * string literals and avoids pulling in a SQL parser.
 */
export async function migrate(client: Client): Promise<string[]> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    (await client.execute("SELECT name FROM schema_migrations")).rows.map((r) => String(r.name)),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).toSorted();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const statements = stripComments(sql)
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    await client.batch(
      [...statements, {
        sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        args: [file, Date.now()],
      }],
      "write",
    );
    ran.push(file);
  }

  return ran;
}

export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && fileURLToPath(metaUrl) === resolve(argv1);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const { createClient } = await import("@libsql/client");
  const url = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
  const client = createClient({ url });
  const ran = await migrate(client);
  console.log(ran.length ? `applied: ${ran.join(", ")}` : "already up to date");
  client.close();
}
