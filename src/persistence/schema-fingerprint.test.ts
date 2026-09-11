import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import {
  assertSchemaCurrent,
  compareSchema,
  expectedSchemaFingerprint,
  hasDrift,
  schemaFingerprint,
  SchemaDriftError,
} from "./schema-fingerprint.js";

describe("schema fingerprint", () => {
  const clients: { close(): void }[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  function open() {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  it("accepts a database the current migrations created", async () => {
    const client = open();
    await migrate(client);
    await expect(assertSchemaCurrent(client)).resolves.toBeUndefined();
  });

  it("names the CHECK a rewritten migration left behind", async () => {
    // What the MP database looked like on 2026-09-11: created by a 0001 that
    // predated the cost ceiling, recorded as migrated, and enforcing a
    // stop_reason CHECK that would have refused the write the ceiling makes.
    const client = open();
    await migrate(client);
    await client.batch([
      "DROP TABLE stories",
      `CREATE TABLE stories (
         id TEXT PRIMARY KEY,
         stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN (
           'blocking_question','verify_loop_exceeded','retry_limit_exceeded'))
       )`,
    ], "write");

    const drift = compareSchema(await expectedSchemaFingerprint(), await schemaFingerprint(client));
    expect(hasDrift(drift)).toBe(true);
    expect(drift.changed.map((change) => change.name)).toContain("stories");

    const error = await assertSchemaCurrent(client).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SchemaDriftError);
    expect((error as Error).message).toContain("cost_ceiling_exceeded");
  });

  it("reads a table the migrations no longer declare as drift", async () => {
    const client = open();
    await migrate(client);
    await client.execute("CREATE TABLE leftover (id TEXT PRIMARY KEY)");
    const drift = compareSchema(await expectedSchemaFingerprint(), await schemaFingerprint(client));
    expect(drift.unexpected).toEqual(["leftover"]);
  });

  it("ignores the quotes SQLite adds to a table it has altered", async () => {
    // ALTER TABLE rewrites the stored statement with the name quoted. The
    // table is the same one, and reporting it would bury a real difference.
    const client = open();
    await migrate(client);
    await client.batch([
      "ALTER TABLE stories ADD COLUMN scratch TEXT",
      "ALTER TABLE stories DROP COLUMN scratch",
    ], "write");
    const drift = compareSchema(await expectedSchemaFingerprint(), await schemaFingerprint(client));
    expect(hasDrift(drift)).toBe(false);
  });
});
