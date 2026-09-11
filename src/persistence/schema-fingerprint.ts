import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { migrate } from "./migrate.js";

/**
 * What the database actually enforces, compared with what the migrations say.
 *
 * `migrate` decides a file is applied by its name, and before the first real
 * deployment `0001_init.sql` is rewritten in place rather than followed by
 * `0002+`. A database created by an older 0001 therefore reports itself as
 * migrated while enforcing the older constraints: the MP database still had a
 * three-value stop-reason CHECK on `stories` after `cost_ceiling_exceeded` was
 * added, so a card that reached its ceiling would have failed on the write
 * instead of stopping cleanly. Columns matching is not enough to catch that -
 * the difference lives in a CHECK.
 */

/** One schema object as SQLite stores it, with formatting differences removed. */
export interface SchemaObject {
  type: string;
  name: string;
  sql: string;
}

export interface SchemaFingerprint {
  digest: string;
  objects: SchemaObject[];
}

/**
 * Whitespace, plus the quotes SQLite puts around an object's own name.
 *
 * SQLite stores the statement as written except after ALTER TABLE, which
 * rewrites `CREATE TABLE x` as `CREATE TABLE "x"`. That is the same table, and
 * reporting it as drift would teach whoever reads this report to skim it.
 * Quoting anywhere else in the statement is left alone.
 */
function normalize(sql: string): string {
  return sql
    .replaceAll(/\s+/g, " ")
    .replace(
      /^(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?)"([A-Za-z_][A-Za-z0-9_]*)"/i,
      "$1$2",
    )
    .trim();
}

export async function schemaFingerprint(client: Client): Promise<SchemaFingerprint> {
  const rows = (await client.execute(
    // Objects SQLite creates for itself (sqlite_autoindex_*, the sequence
    // table) carry no sql of their own and are implied by the table that
    // caused them.
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  )).rows;
  const objects = rows.map((row) => ({
    type: String(row.type),
    name: String(row.name),
    sql: normalize(String(row.sql)),
  }));
  const digest = createHash("sha256")
    .update(objects.map((object) => `${object.type} ${object.name} ${object.sql}`).join("\n"))
    .digest("hex");
  return { digest, objects };
}

/**
 * The fingerprint a database created by the current migrations would have.
 *
 * Computed by running them, not stored as a constant: a constant would be one
 * more thing to update when 0001 is rewritten, and the update that gets
 * forgotten is the one that makes the check pass while the schema drifts.
 */
export async function expectedSchemaFingerprint(): Promise<SchemaFingerprint> {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: ":memory:" });
  try {
    await migrate(client);
    return await schemaFingerprint(client);
  } finally {
    client.close();
  }
}

export interface SchemaDrift {
  /** Objects the migrations declare that the database does not have. */
  missing: string[];
  /** Objects the database has that the migrations do not declare. */
  unexpected: string[];
  /** Objects present in both whose definitions differ, with both texts. */
  changed: { name: string; expected: string; actual: string }[];
}

export function compareSchema(expected: SchemaFingerprint, actual: SchemaFingerprint): SchemaDrift {
  const expectedByName = new Map(expected.objects.map((object) => [object.name, object]));
  const actualByName = new Map(actual.objects.map((object) => [object.name, object]));
  const drift: SchemaDrift = { missing: [], unexpected: [], changed: [] };
  for (const [name, object] of expectedByName) {
    const found = actualByName.get(name);
    if (!found) drift.missing.push(name);
    else if (found.sql !== object.sql) {
      drift.changed.push({ name, expected: object.sql, actual: found.sql });
    }
  }
  for (const name of actualByName.keys()) {
    if (!expectedByName.has(name)) drift.unexpected.push(name);
  }
  return drift;
}

export function hasDrift(drift: SchemaDrift): boolean {
  return drift.missing.length > 0 || drift.unexpected.length > 0 || drift.changed.length > 0;
}

/**
 * Business language, because this is read by whoever is asked to fix it: name
 * the objects, and say what to do about a database that cannot be migrated
 * forward because the migration it needs was rewritten rather than added.
 */
export function renderSchemaDrift(drift: SchemaDrift): string {
  const lines: string[] = ["The database does not match the migrations this build ships."];
  if (drift.missing.length > 0) {
    lines.push(`Missing: ${drift.missing.toSorted().join(", ")}`);
  }
  if (drift.unexpected.length > 0) {
    lines.push(`Not declared by the migrations: ${drift.unexpected.toSorted().join(", ")}`);
  }
  for (const change of drift.changed.toSorted((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      `${change.name} differs:`,
      `  the migrations say: ${change.expected}`,
      `  the database says: ${change.actual}`,
    );
  }
  lines.push(
    "Before the first real deployment 0001_init.sql is rewritten rather than followed by 0002+,",
    "so a database created by an older 0001 reports itself as migrated while enforcing the older rules.",
    "Back the file up, recreate it from the current migrations, and import what has to survive.",
  );
  return lines.join("\n");
}

export class SchemaDriftError extends Error {
  constructor(readonly drift: SchemaDrift) {
    super(renderSchemaDrift(drift));
    this.name = "SchemaDriftError";
  }
}

/**
 * Refuses to take work on a database the running code does not agree with.
 * Called at startup, before the first card is picked up: finding this at the
 * moment a card reaches its cost ceiling means finding it as a write failure
 * in the middle of somebody's Story.
 */
export async function assertSchemaCurrent(client: Client): Promise<void> {
  const drift = compareSchema(await expectedSchemaFingerprint(), await schemaFingerprint(client));
  if (hasDrift(drift)) throw new SchemaDriftError(drift);
}
