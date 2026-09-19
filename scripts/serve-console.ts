import { createClient } from "@libsql/client";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { LibsqlConsoleDataSource } from "../src/console/libsql-data-source.js";
import { createOverviewPage } from "../src/console/overview-page.js";
import { seedOverviewDemo } from "../src/console/overview-demo.js";
import { createConsoleServer, listenConsole } from "../src/console/server.js";
import { migrate } from "../src/persistence/migrate.js";

/**
 * The console as a standalone process.
 *
 * The orchestrator mounts the same server in-process; this entry exists so the
 * screen can be started on its own -- for a review, or on a host that should
 * only serve the read surface. Pointed at no database it opens a temporary
 * demonstration store and fills it with a dataset where every section has
 * something to show; pointed at `HIVEMIND_DB_URL` (or `--db`) it reads the
 * central store and writes nothing into it.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(option("--port") ?? process.env.HIVEMIND_CONSOLE_PORT ?? "3210");
const host = option("--host") ?? process.env.HIVEMIND_CONSOLE_HOST ?? "127.0.0.1";

/** A `file:` URL names a database that may not exist on this host; anything
 * else (an explicit `--db`, or a remote URL) is taken at its word. */
function databaseExists(url: string): boolean {
  return !url.startsWith("file:") || existsSync(url.slice("file:".length));
}

const explicitDb = option("--db");
const configuredDb = process.env.HIVEMIND_DB_URL;
// The orchestrator exports HIVEMIND_DB_URL to every child it starts, so a test
// worktree inherits a path that is not there. Falling back to the demonstration
// store keeps the standalone entry startable without ever writing into the
// central store. The store is a temporary file rather than `:memory:` because a
// read runs in its own transaction, and an in-memory database does not survive
// the connection that transaction closes.
let demoDirectory: string | undefined;
function demoDatabaseUrl(): string {
  demoDirectory = mkdtempSync(join(tmpdir(), "hivemind-console-demo-"));
  return `file:${join(demoDirectory, "console.db")}`;
}

const dbUrl = explicitDb
  ?? (configuredDb !== undefined && databaseExists(configuredDb) ? configuredDb : demoDatabaseUrl());

const client = createClient({ url: dbUrl });
await migrate(client);
if (demoDirectory !== undefined) await seedOverviewDemo(client, Date.now());

const app = await createConsoleServer(
  new LibsqlConsoleDataSource(client, async () => []),
  {
    uiRoot: join(ROOT, "console-ui"),
    overviewPage: createOverviewPage(),
  },
);
const address = await listenConsole(app, { host, port });
console.log(`Console at ${address}`);

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await app.close();
client.close();
if (demoDirectory !== undefined) await rm(demoDirectory, { recursive: true, force: true });
