import { isAbsolute, resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  client: Client;
  close(): void;
}

/**
 * The central store's address, resolved so it still names the same file from
 * another directory.
 *
 * A relative file URL is a working-directory fact, and this address travels:
 * every long-running process hands it to children, and one of those children
 * is the application a verification round starts inside the worktree under
 * verification, where `data/` does not exist. Read there, a relative address
 * either finds nothing or, worse, creates an empty database next to the code
 * being judged.
 */
export function absoluteDbUrl(url: string): string {
  if (!url.startsWith("file:")) return url;
  const [file, query] = url.slice("file:".length).split(/(?=\?)/);
  return file === undefined || file === "" || isAbsolute(file) ? url : `file:${resolve(file)}${query ?? ""}`;
}

/**
 * Opens the central store. A file URL is the normal case; ":memory:" is used by
 * tests. The orchestrator is the only process that opens this for writing.
 */
export function openDb(url: string): DbHandle {
  const client = createClient({ url });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}
