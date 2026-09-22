/**
 * The console as a standalone process, so a round can open its pages and judge
 * them.
 *
 * The orchestrator mounts the same server in-process and that is the console a
 * person reads: it serves the central store. This entry exists for the rounds
 * that judge the screens -- and a round must judge the sample data its
 * scenarios declare, not whatever the worktree happened to inherit. The
 * orchestrator exports `HIVEMIND_DB_URL` to every child it starts, so a review
 * that honored it would serve a real deployment's running work and every
 * scenario written about its own sample would be refused for the work it could
 * not see. The review therefore opens a temporary store and fills it with the
 * declared dataset; only an explicit `--db` reads a database somebody named on
 * purpose, and that one is still served from a private copy so the round cannot
 * write to it.
 *
 * The store is a temporary file rather than `:memory:` because a read runs in
 * its own transaction, and an in-memory database does not survive the
 * connection that closes it.
 */
import { execFile } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { createConsoleServer, listenConsole } from "../src/console/server.js";
import { LibsqlConsoleDataSource } from "../src/console/libsql-data-source.js";
import { seedCurrentWorkDemo } from "../src/console/current-work-demo.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { pinnedPiVersion } from "../src/runner/pi-binary.js";

const execFileAsync = promisify(execFile);

const ROOT = new URL("..", import.meta.url).pathname;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const port = Number(flag("port") ?? process.env.HIVEMIND_CONSOLE_PORT ?? 4319);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`--port must be a port number, got ${flag("port")}`);
}

const uiRoot = join(ROOT, "console-ui", "dist");
// The console's screens are a built shell, and the build output is ignored by
// git, so it survives in a worktree from one round to the next. Serving what
// happens to be there would show a verification round the interface of an
// earlier round rather than of the tree it is judging, so starting the console
// means building it. It takes well under a second, and a repository with no
// shell to build keeps its server-rendered pages.
if (existsSync(join(ROOT, "vite.config.ts"))) {
  try {
    await execFileAsync(join(ROOT, "node_modules", ".bin", "vite"), ["build"], { cwd: ROOT });
  } catch (cause) {
    const output = cause instanceof Error && "stderr" in cause ? String(cause.stderr) : String(cause);
    throw new Error(`the console's screens could not be built, so there is nothing to serve: ${output.trim()}`, { cause });
  }
}

// A console killed outright never reaches its own cleanup, and a store is the
// size of the central database, so the leak is measured in gigabytes. One round
// lasts minutes; anything of ours still here after an hour was orphaned.
const TEMP_PREFIX = "hivemind-console-";
const ORPHAN_AGE_MS = 60 * 60 * 1000;

function removeOrphanedStores(): void {
  const now = Date.now();
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const path = join(tmpdir(), entry);
    try {
      if (now - statSync(path).mtimeMs < ORPHAN_AGE_MS) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Another console owns it, or it went away between the two calls. Either
      // way it is not ours to clean up and the next start will look again.
    }
  }
}

removeOrphanedStores();
const temporaryDirectory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));

const explicitUrl = flag("db");
let serveUrl: string;
if (explicitUrl === undefined) {
  serveUrl = await openDemonstrationStore(join(temporaryDirectory, "console.db"));
} else {
  serveUrl = await openPrivateCopy(explicitUrl, temporaryDirectory);
}

// The demonstration store is migrated and filled with the samples the
// scenarios declare. A real database handed in through `--db` keeps exactly
// what it holds; a round must never be served sample data it did not ask for.
async function openDemonstrationStore(path: string): Promise<string> {
  const handle = openDb(`file:${path}`);
  try {
    await migrate(handle.client);
    await seedCurrentWorkDemo(handle.client, Date.now());
  } finally {
    handle.close();
  }
  return `file:${path}`;
}

// A snapshot is the size of the central database. Running out of disk halfway
// through one leaves a truncated copy that reads like a database with less in
// it, and the round would judge screens against it. Refusing outright makes the
// round report that it had no application, which is a fact somebody can act on.
function assertRoomFor(databaseFile: string, directory: string): void {
  const wal = `${databaseFile}-wal`;
  const needed = statSync(databaseFile).size + (existsSync(wal) ? statSync(wal).size : 0);
  const stats = statfsSync(directory);
  const free = stats.bavail * stats.bsize;
  if (free > needed * 1.2) return;
  throw new Error(
    `not enough disk for a private copy of the database: it is ${Math.round(needed / 1e6)}MB `
    + `and ${Math.round(free / 1e6)}MB is free. The console serves a copy so a round cannot write `
    + `to the central database, so it does not start without room for one.`,
  );
}

async function openPrivateCopy(url: string, directory: string): Promise<string> {
  // libsql creates a missing file, so a wrong URL would serve every page as its
  // empty state and look like a working application. Refusing is what lets the
  // round report that it had no application rather than judge the screens of a
  // database nobody wrote to.
  const file = url.startsWith("file:") ? url.slice("file:".length).split("?")[0]! : "";
  if (file === "") return url;
  if (!existsSync(file)) throw new Error(`no database at ${file}: pass --db or leave it out for the sample store`);
  const target = join(directory, "console.db");
  assertRoomFor(file, directory);
  const origin = openDb(url);
  try {
    await origin.client.execute({ sql: "VACUUM INTO ?", args: [target] });
  } finally {
    origin.close();
  }
  return `file:${target}`;
}

const handle = openDb(serveUrl);
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
  rmSync(temporaryDirectory, { recursive: true, force: true });
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
