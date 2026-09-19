/**
 * The console, on its own, for a verification round to open pages against.
 *
 * A scenario declared `ui` or `e2e` is judged on a screen, and a screen needs
 * something serving it. Until this existed the repository had no way to start
 * its own application, so `verify.appStartCommand` stayed empty and every such
 * scenario came back inconclusive -- or worse, came back passed from a session
 * that had stood up something of its own and judged that instead.
 *
 * It serves the todo surface as well as the page that reads it: the screens a
 * round opens include the one a person answers a waiting decision on, and an
 * application that serves the page but not `/api/todos` shows every waiting
 * todo as unreadable. The one assembly of that surface lives in
 * `createVerificationConsole`, so the entry point and the daemon cannot drift.
 *
 * It serves a private copy of the database, taken when it starts. The screens
 * under judgement answer decisions, and the only safe place for that write is a
 * copy nobody else reads; it also lets the copy catch up to the migrations this
 * build ships, which a database an older `0001` created does not.
 */
import { hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { listenConsole } from "../src/console/server.js";
import { createVerificationConsole } from "../src/console/app-entry.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import {
  compareSchema,
  expectedSchemaFingerprint,
  schemaFingerprint,
} from "../src/persistence/schema-fingerprint.js";
import { createTodoDecisionDelivery } from "../src/notion/todo-decision-delivery.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { createNotionHttpTransport } from "../src/notion/sdk-adapters.js";
import { loadSecretsFile } from "../src/config/secrets-file.js";
import type { NotionOutboxDelivery } from "../src/notion/outbox.js";

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
const named = url.startsWith("file:") ? url.slice("file:".length).split("?")[0]! : "";

/**
 * The file a relative `file:` address names, looked up from here upwards.
 *
 * The address travels from the daemon, and a relative path in it is a fact
 * about the daemon's working directory, not about this process: the daemon runs
 * at the repository root, the application under verification runs inside the
 * worktree, and the worktree has no `data/` to find. Read as written, the
 * address names nothing -- or, worse, libsql creates an empty database beside
 * the code being judged. The daemon's directory is an ancestor of this one.
 */
function locateDatabase(file: string): string {
  if (isAbsolute(file)) return file;
  for (let directory = process.cwd(); ;) {
    const candidate = resolve(directory, file);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return resolve(process.cwd(), file);
    directory = parent;
  }
}

const file = named === "" ? "" : locateDatabase(named);
if (file === "" || !existsSync(file)) {
  throw new Error(`no database at ${named}: set HIVEMIND_DB_URL or pass --db`);
}

/**
 * A private copy of the database, taken through the filesystem.
 *
 * The write-ahead log travels with it: what is newest is exactly what a round
 * is judging, and a copy of the main file alone would drop it. SQLite recovers
 * the log when the copy is opened.
 *
 * A console killed outright never reaches its own cleanup, and a snapshot is
 * the size of the central database, so the leak is measured in gigabytes. One
 * round lasts minutes; anything of ours older than an hour was orphaned by a
 * round that is over.
 */
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

function snapshotOf(source: string): { url: string; discard: () => void } {
  removeOrphanedSnapshots();
  const directory = mkdtempSync(join(tmpdir(), SNAPSHOT_PREFIX));
  const target = join(directory, "console.db");
  cpSync(source, target);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) cpSync(`${source}${suffix}`, `${target}${suffix}`);
  }
  return { url: `file:${target}`, discard: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * Brings the copy up to the migrations this build ships.
 *
 * Before the first deployment `0001_init.sql` is rewritten in place rather than
 * followed by `0002+`, and `migrate` decides a file is applied by its name. A
 * database an older `0001` built therefore records itself as migrated while
 * missing the tables the code now reads -- here the one a waiting todo keeps
 * its decision in. Every statement in that file is `IF NOT EXISTS`, so running
 * it again adds what is missing and leaves the rest alone.
 *
 * Only what is missing is added. The copy is a snapshot of a database this
 * branch may not own -- a daemon running an older or newer tree built some of
 * its tables differently -- and the todo surface reads a handful of them, not
 * all of them. Requiring the whole schema to match would refuse to serve a
 * page whose own table is present over a disagreement about the cost ledger.
 */
async function ensureSchema(client: Parameters<typeof migrate>[0]): Promise<void> {
  await migrate(client);
  const drift = compareSchema(await expectedSchemaFingerprint(), await schemaFingerprint(client));
  if (drift.missing.length === 0) return;
  await client.execute("DELETE FROM schema_migrations");
  await migrate(client);
}

/**
 * Where an accepted decision goes.
 *
 * The token comes from the same place the daemon takes it. Without one the
 * decision is still accepted and kept in the ledger, but it stays queued
 * rather than being reported as kept, because nothing could confirm it
 * reached Notion.
 */
async function resolveDelivery(): Promise<NotionOutboxDelivery> {
  const secrets = await loadSecretsFile().catch(() => new Map<string, string>());
  const token = process.env.NOTION_TOKEN ?? secrets.get("NOTION_TOKEN");
  if (!token) {
    return {
      isApplied: async () => false,
      send: async () => {
        throw new Error("no Notion token is available: the decision stays queued");
      },
    };
  }
  const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token }) });
  return createTodoDecisionDelivery({ gateway });
}

const snapshot = snapshotOf(resolve(file));
const handle = openDb(snapshot.url);
await ensureSchema(handle.client);

const uiRoot = join(ROOT, "console-ui", "dist");
const app = await createVerificationConsole({
  client: handle.client,
  delivery: await resolveDelivery(),
  uiRoot,
  serveUi: existsSync(join(uiRoot, "index.html")),
});

const address = await listenConsole(app, { host: "127.0.0.1", port });
console.log(`console ready at ${address} for ${hostname()}`);

const close = async (): Promise<void> => {
  await app.close().catch(() => undefined);
  handle.close();
  snapshot.discard();
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
