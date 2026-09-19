/**
 * The console, on its own, for a verification round to open pages against.
 *
 * A scenario declared `ui` or `e2e` is judged on a screen, and a screen needs
 * something serving it. Until this existed the repository had no way to start
 * its own application, so `verify.appStartCommand` stayed empty and every such
 * scenario came back inconclusive -- or worse, came back passed from a session
 * that had stood up something of its own and judged that instead.
 *
 * Read-only by construction: no config writer is passed, so the console's one
 * write surface is not registered and every non-GET is refused by the server's
 * own hook. It reads the central database directly rather than a copy, because
 * the screens under judgement are screens of real rounds, real costs and real
 * blockers -- a freshly migrated database renders every page as its empty
 * state, which is exactly one of the things the scenarios need to tell apart.
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createConsoleServer, listenConsole } from "../src/console/server.js";
import { LibsqlConsoleDataSource } from "../src/console/libsql-data-source.js";
import { openDb } from "../src/persistence/client.js";
import { pinnedPiVersion } from "../src/runner/pi-binary.js";

const ROOT = new URL("..", import.meta.url).pathname;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(flag("port") ?? process.env.HIVEMIND_CONSOLE_PORT ?? 4319);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`--port must be a port number, got ${flag("port")}`);
}
// The worktree under verification has no data directory of its own -- data/ is
// ignored -- so the central database is named by the environment the worker
// already runs in, and only fallen back to relative for a direct invocation.
const url = flag("db") ?? process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
// libsql creates a missing file, so an unset HIVEMIND_DB_URL would serve every
// page as its empty state and look like a working application. Refusing is
// what lets the round report that it had no application rather than judge the
// screens of a database nobody wrote to.
const file = url.startsWith("file:") ? url.slice("file:".length).split("?")[0]! : "";
if (file !== "" && !existsSync(file)) {
  throw new Error(`no database at ${file}: set HIVEMIND_DB_URL or pass --db`);
}

const handle = openDb(url);
const uiRoot = join(ROOT, "console-ui", "dist");
const app = await createConsoleServer(
  new LibsqlConsoleDataSource(handle.client, async () => [{
    hostId: hostname(),
    status: "healthy",
    node: process.version,
    pi: pinnedPiVersion(),
  }]),
  { uiRoot, serveUi: existsSync(join(uiRoot, "index.html")) },
);

const address = await listenConsole(app, { host: "127.0.0.1", port });
console.log(`console ready at ${address}`);

const close = async (): Promise<void> => {
  await app.close().catch(() => undefined);
  handle.close();
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
