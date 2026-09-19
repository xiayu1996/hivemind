/**
 * The console, on its own, for a verification round to open pages against.
 *
 * A scenario declared `ui` or `e2e` is judged on a screen, and a screen needs
 * something serving it. Until this existed the repository had no way to start
 * its own application, so `verify.appStartCommand` stayed empty and every such
 * scenario came back inconclusive -- or worse, came back passed from a session
 * that had stood up something of its own and judged that instead.
 *
 * It serves a private snapshot of the central database, taken when it starts
 * and deleted when it stops. Real data, because the screens under judgement are
 * screens of real rounds, real costs and real blockers -- a freshly migrated
 * database renders every page as its empty state, which is exactly one of the
 * things the scenarios need to tell apart. A snapshot rather than the database
 * itself, because a round that submits a decision on a screen must not submit a
 * real one: the writing surfaces are what the scenarios are there to exercise,
 * and the only safe place for that write is a copy nobody reads afterwards.
 * It also means two rounds judging the same screen start from the same picture.
 */
import { execFile } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createConsoleServer, listenConsole } from "../src/console/server.js";
import { LibsqlConsoleDataSource } from "../src/console/libsql-data-source.js";
import { openDb } from "../src/persistence/client.js";
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

// The snapshot is taken through the database rather than off the filesystem:
// a file copy would miss whatever is still in the write-ahead log, and what is
// newest is exactly what a round is judging.
// A console killed outright never reaches its own cleanup, and a snapshot is
// the size of the central database, so the leak is measured in gigabytes. One
// round lasts minutes; anything of ours still here after an hour was orphaned.
const SNAPSHOT_PREFIX = "hivemind-console-";
const ORPHAN_AGE_MS = 60 * 60 * 1000;

function removeOrphanedSnapshots(): void {
  const now = Date.now();
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(SNAPSHOT_PREFIX)) continue;
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

removeOrphanedSnapshots();
const snapshotDir = url.startsWith("file:") ? mkdtempSync(join(tmpdir(), SNAPSHOT_PREFIX)) : null;

async function snapshotOf(source: string, directory: string): Promise<string> {
  const target = join(directory, "console.db");
  const origin = openDb(source);
  try {
    await origin.client.execute({ sql: "VACUUM INTO ?", args: [target] });
  } finally {
    origin.close();
  }
  return `file:${target}`;
}

const handle = openDb(snapshotDir === null ? url : await snapshotOf(url, snapshotDir));
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
  if (snapshotDir !== null) rmSync(snapshotDir, { recursive: true, force: true });
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
