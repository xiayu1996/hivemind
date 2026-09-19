import { createClient } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { LibsqlConsoleDataSource } from "../src/console/libsql-data-source.js";
import { createConsoleAccessPage, createConsoleAccessPolicy } from "../src/console/access-control.js";
import { createOverviewPage } from "../src/console/overview-page.js";
import { seedOverviewDemo } from "../src/console/overview-demo.js";
import { createConsoleServer, listenConsole } from "../src/console/server.js";
import { ConfigStore } from "../src/config/store.js";
import { migrate } from "../src/persistence/migrate.js";

/**
 * The console as a standalone process, on its own data.
 *
 * The orchestrator mounts the same server in-process and that is the console a
 * person reads: it serves the central store. This entry exists so a round can
 * open the screen and judge it -- and a round must judge the sample data its
 * scenarios declare, not whatever the worktree happened to inherit. The
 * orchestrator exports `HIVEMIND_DB_URL` to every child it starts, so a review
 * that honored it would serve a real deployment's running work and every
 * scenario written about its own sample would be refused for the work it could
 * not see. The review therefore always opens a temporary store and fills it
 * with the declared dataset; only an explicit `--db` reads a database somebody
 * named on purpose.
 *
 * The store is a temporary file rather than `:memory:` because a read runs in
 * its own transaction, and an in-memory database does not survive the
 * connection that transaction closes.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(option("--port") ?? process.env.HIVEMIND_CONSOLE_PORT ?? "3210");
const host = option("--host") ?? process.env.HIVEMIND_CONSOLE_HOST ?? "127.0.0.1";

let demoDirectory: string | undefined;
function demoDatabaseUrl(): string {
  demoDirectory = mkdtempSync(join(tmpdir(), "hivemind-console-demo-"));
  return `file:${join(demoDirectory, "console.db")}`;
}

const explicitDb = option("--db");
const dbUrl = explicitDb ?? demoDatabaseUrl();

const client = createClient({ url: dbUrl });
await migrate(client);
if (demoDirectory !== undefined) await seedOverviewDemo(client, Date.now());

// The access range is configuration, not a flag: a range passed on the command
// line would be a second place to widen the console. An unconfigured store
// denies everything, which is the standalone entry telling the reviewer it has
// not been told which home or office network may enter.
const config = await ConfigStore.load(client);

const app = await createConsoleServer(
  new LibsqlConsoleDataSource(client, async () => []),
  {
    accessPolicy: createConsoleAccessPolicy({ allowedNetworks: config.get("console.allowedNetworks") }),
    accessPage: createConsoleAccessPage(),
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
