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
 * Opens the central store. A file URL is the normal case; ":memory:" is used by
 * tests. The orchestrator is the only process that opens this for writing.
 */
export function openDb(url: string): DbHandle {
  const client = createClient({ url });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}
