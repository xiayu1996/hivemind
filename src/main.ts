#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { parse as parseYaml } from "yaml";
import { checkModels, modelsFileSchema, type ModelsFile } from "./agents/models.ts";
import { PromptLibrary } from "./agents/prompt.ts";
import { createModelRuntime, createPiSessions } from "./adapters/pi.ts";
import { approveLocal, commentLocal, createLocalBoard, submitLocal } from "./adapters/board-local.ts";
import { openEvaluatorBrowser, replayScript } from "./adapters/browser.ts";
import { startApp } from "./adapters/app.ts";
import { createGit } from "./adapters/git.ts";
import { createNotionBoard } from "./adapters/notion/board.ts";
import { createNotionTransport } from "./adapters/notion/http.ts";
import { baseEnvironment, runCommand } from "./adapters/process.ts";
import { APP_ROOT, definedOnly, loadInstance, loadRecipes, loadSecrets, type Instance } from "./config.ts";
import { createLog, type Log } from "./log.ts";
import type { LoopContext } from "./loop/context.ts";
import { Engine } from "./loop/engine.ts";
import { loadMessages, type Messages } from "./loop/messages.ts";
import type { AgentSession, AgentSessions, Board, Role, RunningApp, StartApp } from "./ports.ts";
import { closedHealth, DEFAULT_BREAKER_POLICY, type ProviderHealth } from "./resilience/breaker.ts";
import type { ErrorClass } from "./resilience/classify.ts";
import { openDatabase, type OpenedDatabase } from "./store/db.ts";
import { Store, type RequirementRow, type Waiting } from "./store/store.ts";

/**
 * The composition root and the command line. This is the one place that
 * knows every adapter; the loop sees only the ports. Removing a capability
 * means deleting its adapter and its line here.
 */

const USAGE = `usage: hivemind <command>

  run                        work the board until stopped (one process per database)
  submit --repo <name> --title <text> [--recipe <name>] [--body <text> | --body-file <path>]
  status [<ref-or-id>]       every requirement, or one in detail
  approve <ref-or-id>        approve what the requirement waits for (local board)
  comment <ref-or-id> <text> comment on a requirement (local board)
  budget <ref-or-id> <usd>   change a budget; resumes a requirement its budget stopped
  providers [reset <id>]     provider health, or clear a provider a person has fixed
  preflight [--probe]        check configuration, credentials, repositories and the browser;
                             --probe also sends one short request to every configured model

The instance configuration is ~/.hivemind/config.yaml, or the file HIVEMIND_CONFIG names.`;

/** The loop's claim on the database. Renewed well inside its lifetime; losing it ends the process. */
const LEASE_NAME = "loop";
const LEASE_MS = 120_000;

interface Service {
  instance: Instance;
  store: Store;
  database: OpenedDatabase;
  messages: Messages;
  models: ModelsFile;
  secrets: Map<string, string>;
  log: Log;
  board: Board;
}

async function openService(instance: Instance, echo: boolean): Promise<Service> {
  const secrets = await loadSecrets(instance.secrets);
  const log = createLog({ path: join(instance.workRoot, "logs", "hivemind.jsonl"), secrets, ...(echo ? { echo: (line: string) => process.stderr.write(`${line}\n`) } : {}) });
  const messages = await loadMessages(join(APP_ROOT, "config", "messages.yaml"));
  const models = modelsFileSchema.parse(parseYaml(await readFile(instance.modelsFile, "utf8")));
  const database = await openDatabase(instance.database);
  const store = new Store(database.db);
  return { instance, store, database, messages, models, secrets, log, board: createBoard(instance, secrets, messages) };
}

function createBoard(instance: Instance, secrets: ReadonlyMap<string, string>, messages: Messages): Board {
  const board = instance.board;
  if (board.kind === "local") return createLocalBoard(board.root);
  const token = secrets.get(board.tokenSecret);
  if (token === undefined) throw new Error(`the Notion board needs the secret ${board.tokenSecret} in the secrets file`);
  return createNotionBoard({
    transport: createNotionTransport({ token }),
    requirementsDataSourceId: board.dataSourceId,
    botUserId: board.botUserId,
    text: { ...messages.notion, properties: { ...messages.notion.properties, ...definedOnly(board.properties) } },
  });
}

/** Everything the loop needs, with every started app and open session tracked so a shutdown can end them. */
async function loopContext(service: Service): Promise<{ context: LoopContext; shutdown: () => Promise<void> }> {
  const { instance, store, secrets, models, log } = service;
  const runtime = await createModelRuntime({ authPath: instance.piAuth, models });
  const problems = checkModels(models, (provider, model) => runtime.getModel(provider, model));
  if (problems.length > 0) throw new Error(`${instance.modelsFile} is not usable:\n${problems.map((line) => `- ${line}`).join("\n")}`);

  const apps = new Set<RunningApp>();
  const open = new Set<AgentSession>();
  const trackedStart: StartApp = async (input) => {
    const started = await startApp(input);
    if (!started.ok) return started;
    const app = started.app;
    apps.add(app);
    const stop = async () => {
      apps.delete(app);
      await app.stop();
    };
    return { ok: true, app: { origin: app.origin, port: app.port, output: () => app.output(), stop } };
  };
  const piSessions = createPiSessions({ models: runtime, providers: models.providers, secrets, health: healthStore(store), breaker: DEFAULT_BREAKER_POLICY });
  const sessions: AgentSessions = {
    async open(request) {
      const opened = await piSessions.open(request);
      if (!opened.ok) return opened;
      const session = opened.session;
      open.add(session);
      return {
        ok: true,
        session: {
          get model() {
            return session.model;
          },
          send: (message) => session.send(message),
          usage: () => session.usage(),
          close: () => {
            open.delete(session);
            session.close();
          },
        },
      };
    },
  };
  const passed = pick(process.env, instance.passEnv);
  const gitEnv = baseEnvironment({ ...pick(process.env, ["SSH_AUTH_SOCK"]), ...pickMap(secrets, ["GH_TOKEN"]) });
  const context: LoopContext = {
    store,
    board: service.board,
    git: createGit({ workRoot: instance.workRoot, run: runCommand, env: gitEnv }),
    sessions,
    run: runCommand,
    startApp: trackedStart,
    openBrowser: openEvaluatorBrowser,
    replay: replayScript,
    prompts: new PromptLibrary(join(APP_ROOT, "prompts")),
    messages: service.messages,
    config: {
      workRoot: instance.workRoot,
      repositories: instance.repositories,
      models,
      recipes: await loadRecipes(),
      limits: instance.limits,
      defaultBudgetUsd: instance.budgetUsd,
      sessions: instance.sessions,
      childEnv: (extra = {}) => baseEnvironment({ ...passed, ...extra }),
    },
    now: Date.now,
    log,
  };
  const shutdown = async () => {
    for (const session of open) session.close();
    await Promise.allSettled([...apps].map((app) => app.stop()));
  };
  return { context, shutdown };
}

/** The breaker's records as the store keeps them; the class is whatever the classifier wrote. */
function healthStore(store: Store) {
  return {
    providerHealth: async () => {
      const rows = await store.providerHealth();
      return new Map([...rows].map(([provider, row]) => [provider, { ...row, lastErrorClass: row.lastErrorClass as ErrorClass | null } satisfies ProviderHealth]));
    },
    putProviderHealth: (health: ProviderHealth) => store.putProviderHealth(health),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function run(instance: Instance): Promise<void> {
  const service = await openService(instance, true);
  const { store, log } = service;
  const holder = `${hostname()}:${process.pid}`;
  const fence = await store.acquireLease(LEASE_NAME, holder, LEASE_MS);
  if (fence === null) throw new Error("another hivemind process holds this database; stop it first");
  const { context, shutdown } = await loopContext(service);
  const interrupted = await store.interruptRunningRuns();
  log("service.started", { holder, fence, repositories: [...instance.repositories.keys()], board: instance.board.kind, interruptedRuns: interrupted });

  let exiting = false;
  const exit = async (code: number, why: string) => {
    if (exiting) return;
    exiting = true;
    log("service.stopping", { why });
    clearInterval(renewal);
    await shutdown();
    await store.releaseLease(LEASE_NAME, holder, fence).catch(() => undefined);
    service.database.close();
    process.exit(code);
  };
  // State is committed after every unit of work, so stopping mid-session only repeats that session.
  process.once("SIGINT", () => void exit(0, "SIGINT"));
  process.once("SIGTERM", () => void exit(0, "SIGTERM"));
  const renewal = setInterval(() => {
    store.renewLease(LEASE_NAME, holder, fence, LEASE_MS).then(
      (held) => {
        if (!held) void exit(1, "the lease was lost; another process may be working this database");
      },
      (error: unknown) => log("lease.renew_failed", { error: String(error) }),
    );
  }, LEASE_MS / 4);

  const engine = new Engine(context);
  for (;;) {
    let wakeAt: number | null = null;
    try {
      const result = await engine.tick();
      if (result.worked) continue;
      wakeAt = result.wakeAt;
    } catch (error) {
      // The board or the database failed outside any requirement; try again after the pause.
      log("tick.failed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
    const pause = instance.pollSeconds * 1000;
    const delay = wakeAt === null ? pause : Math.max(1_000, Math.min(pause, wakeAt - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function submit(instance: Instance, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { repo: { type: "string" }, title: { type: "string" }, recipe: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" } }, strict: true });
  if (instance.board.kind !== "local") throw new Error("submit writes to the local board; on Notion, add a page to the requirements data source");
  if (values.repo === undefined || values.title === undefined) throw new Error("submit needs --repo and --title");
  if (!instance.repositories.has(values.repo)) throw new Error(`repository ${values.repo} is not in ${instance.path}`);
  const body = values["body-file"] !== undefined ? await readFile(values["body-file"], "utf8") : (values.body ?? "");
  const ref = await submitLocal(instance.board.root, { title: values.title, body, repo: values.repo, ...(values.recipe === undefined ? {} : { recipe: values.recipe }), now: new Date() });
  console.log(ref);
}

async function status(instance: Instance, args: string[]): Promise<void> {
  const service = await openService(instance, false);
  try {
    const { store } = service;
    if (args[0] === undefined) {
      const rows = await store.allRequirements();
      if (rows.length === 0) console.log("no requirements yet");
      for (const row of rows) {
        const spent = (await store.spentUsd(row.id)).toFixed(2);
        console.log([row.id, row.boardRef, row.status, row.recipe, `step ${row.stepIndex}`, `$${spent}/${row.budgetUsd}`, row.title].join("  "));
      }
      return;
    }
    const requirement = await findRequirement(store, args[0]);
    console.log(`${requirement.title}\n  id ${requirement.id}  ref ${requirement.boardRef}  repo ${requirement.repo}  branch ${requirement.branch}`);
    console.log(`  status ${requirement.status}${requirement.stopReason === null ? "" : ` (${requirement.stopReason})`}  recipe ${requirement.recipe} step ${requirement.stepIndex}`);
    if (requirement.waiting !== null) console.log(`  waiting ${requirement.waiting}`);
    if (requirement.stopDetail !== null) console.log(`  ${requirement.stopDetail.split("\n").join("\n  ")}`);
    console.log(`  spent $${(await store.spentUsd(requirement.id)).toFixed(2)} of $${requirement.budgetUsd}`);
    for (const item of await store.items(requirement.id)) {
      console.log(`  item ${item.id}  ${item.status}  attempts ${item.attempts}  replans ${item.replans}  ${item.title}`);
    }
    for (const event of (await store.eventsOf(requirement.id)).slice(-15)) {
      console.log(`  ${event.at}  ${event.type}  ${event.data.slice(0, 160)}`);
    }
  } finally {
    service.database.close();
  }
}

async function approve(instance: Instance, args: string[]): Promise<void> {
  if (instance.board.kind !== "local") throw new Error("approve writes to the local board; on Notion, tick the approval box on the page");
  const service = await openService(instance, false);
  try {
    const requirement = await findRequirement(service.store, args[0]);
    const waiting = JSON.parse(requirement.waiting ?? "null") as Waiting | null;
    if (waiting?.kind !== "approval") throw new Error(`${requirement.id} is not waiting for an approval`);
    await approveLocal(instance.board.root, requirement.boardRef, waiting.gate, waiting.revision, userInfo().username);
    console.log(`approved ${waiting.gate} at ${waiting.revision.slice(0, 7)}; the loop takes it up on its next look`);
  } finally {
    service.database.close();
  }
}

async function comment(instance: Instance, args: string[]): Promise<void> {
  if (instance.board.kind !== "local") throw new Error("comment writes to the local board; on Notion, comment on the page");
  const [target, ...words] = args;
  if (words.length === 0) throw new Error("comment needs a text");
  const service = await openService(instance, false);
  try {
    const requirement = await findRequirement(service.store, target);
    await commentLocal(instance.board.root, requirement.boardRef, words.join(" "), new Date());
    console.log(`commented on ${requirement.id}`);
  } finally {
    service.database.close();
  }
}

async function budget(instance: Instance, args: string[]): Promise<void> {
  const usd = Number(args[1]);
  if (!Number.isFinite(usd) || usd < 0) throw new Error("budget needs an amount in US dollars, zero for no ceiling");
  const service = await openService(instance, false);
  try {
    const requirement = await findRequirement(service.store, args[0]);
    await service.store.setBudget(requirement.id, usd);
    if (requirement.status === "stopped" && requirement.stopReason === "budget") await service.store.resume(requirement.id, `budget raised to ${usd}`);
    console.log(`budget of ${requirement.id} is now $${usd}`);
  } finally {
    service.database.close();
  }
}

async function providers(instance: Instance, args: string[]): Promise<void> {
  const service = await openService(instance, false);
  try {
    if (args[0] === "reset") {
      if (args[1] === undefined) throw new Error("providers reset needs a provider id");
      await service.store.putProviderHealth(closedHealth(args[1], Date.now()));
      console.log(`provider ${args[1]} is usable again`);
      return;
    }
    const health = await service.store.providerHealth();
    for (const provider of Object.keys(service.models.providers)) {
      const row = health.get(provider);
      const detail = row === undefined || row.state === "closed" ? "closed" : `${row.state}${row.needsHuman ? " (needs a person)" : ""} until ${row.retryAt === null ? "reset" : new Date(row.retryAt).toISOString()}: ${row.lastErrorClass ?? ""} ${row.lastError ?? ""}`;
      console.log(`${provider}  ${service.models.providers[provider]?.billing ?? ""}  ${detail}`);
    }
  } finally {
    service.database.close();
  }
}

async function preflight(instance: Instance, args: string[]): Promise<void> {
  const probe = args.includes("--probe");
  const results: { check: string; ok: boolean; detail: string }[] = [];
  const record = (check: string, ok: boolean, detail = "") => {
    results.push({ check, ok, detail });
    console.log(`${ok ? "ok  " : "FAIL"}  ${check}${detail === "" ? "" : `: ${detail}`}`);
  };
  const service = await openService(instance, false);
  try {
    record("instance configuration", true, instance.path);
    const recipes = await loadRecipes().then((loaded) => [...loaded.keys()]);
    record("recipes", true, recipes.join(", "));
    for (const repository of instance.repositories.values()) {
      if (!recipes.includes(repository.recipe)) record(`repository ${repository.name} recipe`, false, `${repository.recipe} is not a recipe`);
    }

    const runtime = await createModelRuntime({ authPath: instance.piAuth, models: service.models });
    const problems = checkModels(service.models, (provider, model) => runtime.getModel(provider, model));
    record("models file", problems.length === 0, problems.length === 0 ? instance.modelsFile : problems.join("; "));
    // Presence only: reading a login would refresh it, and a refresh rotates the token under every other holder of it.
    const used = new Set(Object.values(service.models.roles).flatMap((candidates) => candidates.map((candidate) => candidate.provider)));
    const logins = new Map((await runtime.listCredentials()).map((credential) => [credential.providerId, credential.type]));
    for (const provider of used) {
      const keyName = service.models.providers[provider]?.apiKeyEnv;
      if (keyName !== undefined) {
        const present = service.secrets.has(keyName);
        record(`credentials for ${provider}`, present, present ? `${keyName} is in the secrets file` : `${keyName} is missing from ${instance.secrets}`);
        continue;
      }
      const login = logins.get(provider);
      record(`credentials for ${provider}`, login !== undefined, login !== undefined ? `an ${login} login in pi's auth file; --probe shows whether it still works` : "no login in pi's auth file: log in with pi first");
    }

    const gitEnv = baseEnvironment({ ...pick(process.env, ["SSH_AUTH_SOCK"]), ...pickMap(service.secrets, ["GH_TOKEN"]) });
    const gitVersion = await runCommand(["git", "--version"], { cwd: tmpdir(), env: gitEnv, timeoutMs: 10_000 });
    record("git", gitVersion.code === 0, gitVersion.stdout.trim() || gitVersion.spawnError || gitVersion.stderr.trim());
    if ([...instance.repositories.values()].some((repository) => repository.push)) {
      const gh = await runCommand(["gh", "auth", "status"], { cwd: tmpdir(), env: gitEnv, timeoutMs: 20_000 });
      record("gh (pull requests)", gh.code === 0, gh.code === 0 ? "" : (gh.spawnError ?? gh.stderr.trim().split("\n")[0] ?? ""));
    }
    for (const repository of instance.repositories.values()) {
      const listed = await runCommand(["git", "ls-remote", "--heads", repository.url, repository.defaultBranch], { cwd: tmpdir(), env: { ...gitEnv, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 60_000 });
      const ok = listed.code === 0 && listed.stdout.trim() !== "";
      record(`repository ${repository.name}`, ok, ok ? "" : listed.code === 0 ? `origin has no ${repository.defaultBranch} branch; push an initial commit` : listed.stderr.trim().split("\n")[0] ?? "");
    }

    if (instance.board.kind === "local") {
      await mkdir(instance.board.root, { recursive: true });
      record("board", true, `local, ${instance.board.root}`);
    } else {
      const polled = await service.board.pollSubmissions().then(
        (submissions) => `${submissions.length} new submissions`,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      record("board", !(polled instanceof Error), polled instanceof Error ? polled.message : `notion, ${polled}`);
    }
    const browser = chromium.executablePath();
    record("browser", existsSync(browser), existsSync(browser) ? browser : "run: npx playwright install chromium");

    if (probe) await probeModels(service, runtime, record);
  } finally {
    service.database.close();
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

/** One short request per configured model: an id the catalogue knows can still be refused by this account. */
async function probeModels(service: Service, runtime: Awaited<ReturnType<typeof createModelRuntime>>, record: (check: string, ok: boolean, detail?: string) => void): Promise<void> {
  const sessions = createPiSessions({ models: runtime, providers: service.models.providers, secrets: service.secrets, health: healthStore(service.store), breaker: DEFAULT_BREAKER_POLICY, retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } });
  const cwd = await mkdtemp(join(tmpdir(), "hivemind-probe-"));
  try {
    const seen = new Set<string>();
    for (const [role, candidates] of Object.entries(service.models.roles)) {
      for (const candidate of candidates) {
        const key = `${candidate.provider}/${candidate.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const opened = await sessions.open({
          runId: `probe-${Date.now()}-${seen.size}`,
          role: role as Role,
          cwd,
          candidates: [candidate],
          systemPrompt: "Answer in one word.",
          builtinTools: [],
          tools: [],
          policy: { allowedTools: [], root: cwd, writable: [], fenced: [] },
          env: {},
          maxTurns: 1,
          timeoutMs: 90_000,
        });
        if (!opened.ok) {
          record(`model ${key}`, false, opened.reason);
          continue;
        }
        const outcome = await opened.session.send("Reply with the word OK.");
        opened.session.close();
        record(`model ${key}`, outcome.kind === "stopped" || outcome.kind === "turn_limit", outcome.kind === "error" ? `${outcome.errorClass}: ${outcome.message}` : outcome.kind);
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function findRequirement(store: Store, key: string | undefined): Promise<RequirementRow> {
  if (key === undefined) throw new Error("name a requirement by its board ref or its id");
  const found = (await store.requirement(key)) ?? (await store.requirementByRef(key));
  if (found === undefined) throw new Error(`no requirement ${key}`);
  return found;
}

function pick(source: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

function pickMap(source: ReadonlyMap<string, string>, names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = source.get(name);
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  const instance = await loadInstance();
  switch (command) {
    case "run":
      return run(instance);
    case "submit":
      return submit(instance, args);
    case "status":
      return status(instance, args);
    case "approve":
      return approve(instance, args);
    case "comment":
      return comment(instance, args);
    case "budget":
      return budget(instance, args);
    case "providers":
      return providers(instance, args);
    case "preflight":
      return preflight(instance, args);
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
