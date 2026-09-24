import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelsFile } from "../agents/models.ts";
import { PromptLibrary } from "../agents/prompt.ts";
import { startApp } from "../adapters/app.ts";
import { approveLocal, commentLocal, createLocalBoard, submitLocal } from "../adapters/board-local.ts";
import { openEvaluatorBrowser, replayScript } from "../adapters/browser.ts";
import { createGit } from "../adapters/git.ts";
import { createPiSessions } from "../adapters/pi.ts";
import { baseEnvironment, runCommand } from "../adapters/process.ts";
import { APP_ROOT, loadRecipes } from "../config.ts";
import { DEFAULT_LIMITS, type Limits } from "../domain/stop.ts";
import { DEFAULT_BREAKER_POLICY, type ProviderHealth } from "../resilience/breaker.ts";
import type { ErrorClass } from "../resilience/classify.ts";
import { openDatabase, type OpenedDatabase } from "../store/db.ts";
import { Store, type Waiting } from "../store/store.ts";
import type { LoopContext } from "./context.ts";
import { Engine } from "./engine.ts";
import { loadMessages } from "./messages.ts";

/**
 * The whole loop over a real repository, a real browser and a real product,
 * with the three roles played by scripted models: a small change goes from a
 * submission on the board to a delivered branch, through one refused attempt,
 * one model-free replay of a scenario that passed before, the final review
 * and a person's approval.
 */

const CONTRACT = `items:
  - id: A1
    title: Task page
    surface: web
    scenarios:
      - id: A1.1
        title: Open the task page
        given: the product is running
        when: the user opens the task page
        then: the page shows the heading Tasks and an Add task button
        page: /
        visible:
          - { role: heading, text: Tasks }
          - { role: button, text: Add task }
  - id: A2
    title: Greeting command
    surface: cli
    scenarios:
      - id: A2.1
        title: Run the greeting
        given: the repository is checked out
        when: the user runs node hello.js
        then: it prints hello, world
        command: node hello.js
        visible:
          - { text: "hello, world" }
`;

const PLAN = `items:
  - id: page
    kind: feature
    title: Task page
    goal: serve the task page at /
    covers: [A1]
  - id: cli
    kind: feature
    title: Greeting command
    goal: node hello.js prints the greeting
    covers: [A2]
    dependsOn: [page]
`;

const PROJECT = `checks:
  - name: syntax
    run: node --check server.js && (test ! -f hello.js || node --check hello.js)
app:
  start: node server.js
  ready: /
`;

const SERVER = `const http = require("node:http");
http
  .createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Tasks</title><main><h1>Tasks</h1><button>Add task</button></main>");
  })
  .listen(Number(process.env.PORT), "127.0.0.1");
`;

const PRODUCT = "# Greeter\n\nA command that greets whoever runs it, and says goodbye.\n";

const greeterContract = (greeting: string) => `items:
  - id: A1
    title: Greeting
    surface: cli
    scenarios:
      - id: A1.1
        title: Run the greeting
        given: the repository is checked out
        when: the user runs node hello.js
        then: it prints ${greeting}
        command: node hello.js
        visible:
          - { text: "${greeting}" }
  - id: A2
    title: Farewell
    surface: cli
    scenarios:
      - id: A2.1
        title: Run the farewell
        given: the repository is checked out
        when: the user runs node bye.js
        then: it prints goodbye
        command: node bye.js
        visible:
          - { text: goodbye }
`;

const ARCHITECTURE = "# Architecture\n\nOne Node.js script per command, no dependencies.\n";

const GREETER_PROJECT = `checks:
  - name: syntax
    run: node --check hello.js && (test ! -f bye.js || node --check bye.js)
`;

const GREETER_PLAN = `items:
  - id: greeting
    kind: feature
    title: Greeting
    goal: node hello.js prints the greeting
    covers: [A1]
    milestone: true
  - id: farewell
    kind: feature
    title: Farewell
    goal: node bye.js prints goodbye
    covers: [A2]
    dependsOn: [greeting]
`;

// -- scripted models ----------------------------------------------------------

interface View {
  task: string;
  /** Assistant turns already taken in this session. */
  turn: number;
  /** Tool results in order. */
  results: string[];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
    .map((part) => part.text)
    .join("\n");
}

function view(context: Context): View {
  const first = context.messages.find((message) => message.role === "user");
  return {
    task: first === undefined ? "" : textOf(first.content),
    turn: context.messages.filter((message) => message.role === "assistant").length,
    results: context.messages.filter((message) => message.role === "toolResult").map((message) => textOf(message.content)),
  };
}

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });

/** Answers every request of one provider by deciding from the conversation so far. */
function actor(handle: FauxProviderHandle, decide: (seen: View) => AssistantMessage): void {
  handle.setResponses(Array.from({ length: 400 }, () => (context: Context) => decide(view(context))));
}

/** What the planner writes in each step, given the task it was handed; set by each test. */
let plannerFiles: Record<string, (task: string) => [path: string, content: string][]> = {};

function planner(seen: View): AssistantMessage {
  const step = /Carry out the "([a-z-]+)" step/.exec(seen.task)?.[1] ?? (/did not pass within its attempts|A person commented/.test(seen.task) ? "revise" : "");
  const files = plannerFiles[step]?.(seen.task);
  if (files === undefined) throw new Error(`the planner has nothing scripted for step ${step}`);
  const actions = [
    ...files.map(([path, content]) => () => call("write", { path, content })),
    () => call("submit_result", { summary: `The ${step} step is written.`, decisions: [], questions: [] }),
  ];
  const next = actions[seen.turn];
  if (next === undefined) throw new Error(`the planner has nothing scripted for step ${step} turn ${seen.turn}`);
  return next();
}

/** Per plan item, the files each attempt writes before submitting; set by each test. */
let builderAttempts: Record<string, [path: string, content: string][][]> = {};
let noHandbacks = false;
const builderRuns: string[] = [];

function builder(seen: View): AssistantMessage {
  const item = /Build plan item ([a-z-]+)/.exec(seen.task)?.[1] ?? "";
  if (seen.turn === 0) builderRuns.push(item);
  // Without a handback budget every session is one attempt: the n-th session of an item plays its n-th scripted attempt.
  const sessions = builderRuns.filter((run) => run === item).length;
  const scripted = builderAttempts[item] ?? [];
  const attempts = noHandbacks ? [scripted[Math.min(sessions, scripted.length) - 1] ?? []] : scripted;
  const actions: (() => AssistantMessage)[] = [];
  for (const writes of attempts) {
    for (const [path, content] of writes) actions.push(() => call("write", { path, content }));
    actions.push(() => call("submit_result", { summary: "Done.", tests: [], blocker: null }));
  }
  const next = actions[seen.turn];
  if (next === undefined) throw new Error(`the builder has nothing scripted for item ${item} turn ${seen.turn}`);
  return next();
}

const judged: string[][] = [];

/** Drives each scenario it is handed, then passes the ones whose evidence shows every expected text. */
function evaluator(seen: View): AssistantMessage {
  const scenarios = [...seen.task.matchAll(/^### (A\d+\.\d+) .*\((?:page (\S+)|command `([^`]+)`)\)$[\s\S]*?^Must be visible: (.*)$/gm)].map((match) => ({
    id: match[1] ?? "",
    page: match[2],
    command: match[3],
    texts: [...(match[4] ?? "").matchAll(/"([^"]*)"/g)].map((text) => text[1] ?? ""),
  }));
  const actions = scenarios.flatMap((scenario) => [
    () => call("begin_scenario", { scenario_id: scenario.id }),
    ...(scenario.page !== undefined ? [() => call("open_page", { path: scenario.page }), () => call("snapshot", {})] : [() => call("run_command", { command: scenario.command })]),
  ]);
  const action = actions[seen.turn];
  if (action !== undefined) return action();
  if (seen.turn > actions.length) throw new Error("the evaluator's verdict was refused");
  judged.push(scenarios.map((scenario) => scenario.id));
  const captured = seen.results.filter((text) => /^(?:Snapshot S\d+|Output O\d+) of/.test(text));
  const verdicts = scenarios.map((scenario, index) => {
    const shown = captured[index] ?? "";
    const id = /^(?:Snapshot|Output) ([SO]\d+)/.exec(shown)?.[1] ?? "";
    const missing = scenario.texts.find((text) => !shown.includes(text));
    return missing === undefined
      ? { id: scenario.id, outcome: "passed", reason: "It shows what the scenario expects.", evidence: [id] }
      : { id: scenario.id, outcome: "failed", reason: `It does not show ${missing}.`, evidence: [id], cites: missing };
  });
  return call("submit_result", { scenarios: verdicts, findings: [] });
}

// -- fixture ------------------------------------------------------------------

let root: string;
let database: OpenedDatabase;
let store: Store;
let boardRoot: string;

async function sh(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd, env });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function wire(recipe: string, limits: Partial<Limits> = {}): Promise<LoopContext> {
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Hivemind Tests\n\temail = tests@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const env = baseEnvironment({ HOME: root, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" });
  const origin = join(root, "origin", "demo.git");
  const seed = join(root, "seed");
  await mkdir(origin, { recursive: true });
  await mkdir(seed);
  await sh(root, env, "init", "-q", "--bare", "-b", "main", origin);
  await sh(root, env, "init", "-q", "-b", "main", seed);
  await writeFile(join(seed, "README.md"), "demo\n");
  await sh(seed, env, "add", "README.md");
  await sh(seed, env, "commit", "-q", "-m", "seed");
  await sh(seed, env, "remote", "add", "origin", origin);
  await sh(seed, env, "push", "-q", "origin", "main");

  const models = createModels();
  const handles = {
    planner: fauxProvider({ provider: "scripted-planner", models: [{ id: "planner" }] }),
    builder: fauxProvider({ provider: "scripted-builder", models: [{ id: "builder" }] }),
    evaluator: fauxProvider({ provider: "scripted-evaluator", models: [{ id: "evaluator" }] }),
  };
  for (const handle of Object.values(handles)) models.setProvider(handle.provider);
  actor(handles.planner, planner);
  actor(handles.builder, builder);
  actor(handles.evaluator, evaluator);
  const modelsFile: ModelsFile = {
    providers: { "scripted-planner": { billing: "subscription" }, "scripted-builder": { billing: "subscription" }, "scripted-evaluator": { billing: "metered" } },
    roles: {
      planner: [{ provider: "scripted-planner", model: "planner", effort: "medium" }],
      builder: [{ provider: "scripted-builder", model: "builder", effort: "medium" }],
      evaluator: [{ provider: "scripted-evaluator", model: "evaluator", effort: "medium" }],
    },
  };
  const health = {
    providerHealth: async () => new Map([...(await store.providerHealth())].map(([id, row]) => [id, { ...row, lastErrorClass: row.lastErrorClass as ErrorClass | null } satisfies ProviderHealth])),
    putProviderHealth: (record: ProviderHealth) => store.putProviderHealth(record),
  };
  const workRoot = join(root, "work");
  return {
    store,
    board: createLocalBoard(boardRoot),
    git: createGit({ workRoot, run: runCommand, env }),
    sessions: createPiSessions({ models, providers: modelsFile.providers, secrets: new Map(), health, breaker: DEFAULT_BREAKER_POLICY, sleep: async () => {} }),
    run: runCommand,
    startApp,
    openBrowser: openEvaluatorBrowser,
    replay: replayScript,
    prompts: new PromptLibrary(join(APP_ROOT, "prompts")),
    messages: await loadMessages(join(APP_ROOT, "config", "messages.yaml")),
    config: {
      workRoot,
      repositories: new Map([["demo", { name: "demo", url: origin, defaultBranch: "main", push: false, recipe }]]),
      models: modelsFile,
      recipes: await loadRecipes(),
      limits: { ...DEFAULT_LIMITS, ...limits },
      defaultBudgetUsd: 5,
      sessions: { planner: { maxTurns: 20, timeoutMinutes: 2 }, builder: { maxTurns: 20, timeoutMinutes: 2 }, evaluator: { maxTurns: 20, timeoutMinutes: 2 } },
      childEnv: (extra = {}) => ({ ...env, ...extra }),
    },
    now: Date.now,
    log: () => {},
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hivemind-loop-"));
  boardRoot = join(root, "board");
  database = await openDatabase(":memory:");
  store = new Store(database.db);
  builderRuns.length = 0;
  judged.length = 0;
  plannerFiles = {};
  builderAttempts = {};
  noHandbacks = false;
});

afterEach(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

describe("the main loop", () => {
  it("delivers a small change from submission to an approved branch", { timeout: 240_000 }, async () => {
    plannerFiles = {
      scope: () => [
        [".hivemind/acceptance.yaml", CONTRACT],
        [".hivemind/plan.yaml", PLAN],
        [".hivemind/project.yaml", PROJECT],
      ],
    };
    builderAttempts = {
      page: [[["server.js", SERVER]]],
      // The first attempt prints the wrong words; the evaluator refuses it and the finding comes back into the session.
      cli: [[["hello.js", 'console.log("hello");\n']], [["hello.js", 'console.log("hello, world");\n']]],
    };
    const loop = await wire("small-change");
    const engine = new Engine(loop);
    const ref = await submitLocal(boardRoot, { title: "Tasks and a greeting", body: "Show a task page and print a greeting.", repo: "demo", recipe: "small-change", now: new Date() });

    let requirement = await store.requirementByRef(ref);
    for (let tick = 0; tick < 12 && requirement?.status !== "waiting"; tick += 1) {
      await engine.tick();
      requirement = await store.requirementByRef(ref);
      expect(requirement?.status, requirement?.stopDetail ?? "").not.toBe("stopped");
    }
    const waiting = JSON.parse(requirement?.waiting ?? "null") as Waiting | null;
    expect(waiting).toMatchObject({ kind: "approval", gate: "milestone", onApproval: "next_step" });
    if (requirement === undefined || waiting?.kind !== "approval") throw new Error("the review did not ask for approval");

    // Item cli was refused once inside its session, then passed; page was replayed without a model while cli was judged.
    expect(builderRuns).toEqual(["page", "cli"]);
    expect(judged).toEqual([["A1.1"], ["A2.1"], ["A2.1"], ["A1.1", "A2.1"]]);
    const items = await store.items(requirement.id);
    expect(items.map((item) => [item.id, item.status])).toEqual([
      ["page", "passed"],
      ["cli", "passed"],
    ]);

    const worktree = join(root, "work", "worktrees", requirement.id);
    const log = await runCommand(["git", "log", "--format=%s"], { cwd: worktree, env: loop.config.childEnv() });
    expect(log.stdout.trim().split("\n")).toEqual(["item cli: Greeting command", "item page: Task page", ".hivemind: scope", "seed"]);
    expect(await readFile(join(worktree, "hello.js"), "utf8")).toBe('console.log("hello, world");\n');
    const script = JSON.parse(await readFile(join(worktree, ".hivemind", "acceptance", "A1.1.json"), "utf8")) as { steps: unknown[] };
    expect(script.steps).toEqual([{ action: "open", path: "/" }, { action: "snapshot" }]);
    const pageSha = (await runCommand(["git", "rev-parse", "HEAD~1"], { cwd: worktree, env: loop.config.childEnv() })).stdout.trim();
    const progress = await readFile(join(worktree, ".hivemind", "PROGRESS.md"), "utf8");
    expect(progress).toMatch(new RegExp(`^\\| page: Task page \\|.*\\| passed \\(${pageSha.slice(0, 7)}\\) \\|`, "m"));
    // The last row rides in the very commit it would have to name.
    expect(progress).toMatch(/^\| cli: Greeting command \|.*\| passed \|/m);

    await approveLocal(boardRoot, ref, "milestone", waiting.revision, "tester");
    await engine.tick();
    requirement = await store.requirementByRef(ref);
    expect(requirement?.status).toBe("done");
    expect(JSON.parse(await readFile(join(boardRoot, ref, "status.json"), "utf8"))).toMatchObject({ status: "done" });
    expect(await readFile(join(boardRoot, ref, "reports", `${requirement?.id ?? ""}-done.md`), "utf8")).toContain("A2.1");
  });
  it("asks a person at every gate, rewrites on a comment, and shows each gate only what changed", { timeout: 240_000 }, async () => {
    plannerFiles = {
      define: (task) => [
        [".hivemind/PRODUCT.md", PRODUCT],
        [".hivemind/acceptance.yaml", greeterContract(task.includes("upper case") ? "HELLO, WORLD" : "hello, world")],
      ],
      architecture: () => [
        [".hivemind/ARCHITECTURE.md", ARCHITECTURE],
        [".hivemind/project.yaml", GREETER_PROJECT],
      ],
      plan: () => [[".hivemind/plan.yaml", GREETER_PLAN]],
    };
    builderAttempts = {
      greeting: [[["hello.js", 'console.log("HELLO, WORLD");\n']]],
      farewell: [[["bye.js", 'console.log("goodbye");\n']]],
    };
    const engine = new Engine(await wire("greenfield"));
    const ref = await submitLocal(boardRoot, { title: "Greeter", body: "Greet whoever runs it, then say goodbye.", repo: "demo", now: new Date() });

    const nextApproval = async (): Promise<Extract<Waiting, { kind: "approval" }>> => {
      for (let tick = 0; tick < 8; tick += 1) {
        await engine.tick();
        const row = await store.requirementByRef(ref);
        expect(row?.status, row?.stopDetail ?? "").not.toBe("stopped");
        if (row?.status !== "waiting") continue;
        const waiting = JSON.parse(row.waiting ?? "null") as Waiting;
        if (waiting.kind !== "approval") throw new Error(`the requirement waits for ${waiting.kind}, not an approval`);
        return waiting;
      }
      throw new Error("the requirement never asked for an approval");
    };
    const shown = (waiting: Extract<Waiting, { kind: "approval" }>) => readFile(join(boardRoot, ref, "approvals", `${waiting.gate}-${waiting.revision}.md`), "utf8");

    const product = await nextApproval();
    expect(product).toMatchObject({ gate: "product", onApproval: "next_step" });
    expect(await shown(product)).toContain("hello, world");

    // A comment instead of an approval: the same step runs again with it, and the new version is what gets approved.
    await commentLocal(boardRoot, ref, "Print the greeting in upper case.", new Date());
    const revised = await nextApproval();
    expect(revised.gate).toBe("product");
    expect(revised.revision).not.toBe(product.revision);
    expect(await shown(revised)).toContain("HELLO, WORLD");

    await approveLocal(boardRoot, ref, "product", revised.revision, "tester");
    const architecture = await nextApproval();
    expect(architecture.gate).toBe("architecture");
    const architectureShown = await shown(architecture);
    expect(architectureShown).toContain("ARCHITECTURE.md");
    expect(architectureShown).toContain("project.yaml");
    expect(architectureShown).not.toContain("acceptance.yaml");

    await approveLocal(boardRoot, ref, "architecture", architecture.revision, "tester");
    const milestone = await nextApproval();
    expect(milestone).toMatchObject({ gate: "milestone", onApproval: "same_step" });
    expect(builderRuns).toEqual(["greeting"]);

    await approveLocal(boardRoot, ref, "milestone", milestone.revision, "tester");
    const delivery = await nextApproval();
    expect(delivery).toMatchObject({ gate: "milestone", onApproval: "next_step" });
    expect(builderRuns).toEqual(["greeting", "farewell"]);
    // The greeting was replayed without a model while the farewell was judged.
    expect(judged).toEqual([["A1.1"], ["A2.1"], ["A1.1", "A2.1"]]);

    await approveLocal(boardRoot, ref, "milestone", delivery.revision, "tester");
    await engine.tick();
    expect((await store.requirementByRef(ref))?.status).toBe("done");
  });
  it("stops an item that makes no progress and resumes it when a person comments", { timeout: 240_000 }, async () => {
    const quiet = greeterContract("hello, world").split("  - id: A2")[0] ?? "";
    plannerFiles = {
      scope: () => [
        [".hivemind/acceptance.yaml", quiet],
        [".hivemind/plan.yaml", "items:\n  - id: greeting\n    kind: feature\n    title: Greeting\n    goal: node hello.js prints the greeting\n    covers: [A1]\n"],
        [".hivemind/project.yaml", "checks:\n  - name: syntax\n    run: node --check hello.js\n"],
      ],
      revise: () => [],
    };
    const wrong: [string, string][] = [["hello.js", 'console.log("hello");\n']];
    builderAttempts = { greeting: [wrong, wrong, wrong, wrong, [["hello.js", 'console.log("hello, world");\n']]] };
    noHandbacks = true;
    const engine = new Engine(await wire("small-change", { maxItemAttempts: 2, maxReplans: 1, maxHandbacks: 0 }));
    const ref = await submitLocal(boardRoot, { title: "Greeter", body: "Greet whoever runs it.", repo: "demo", now: new Date() });

    let requirement = await store.requirementByRef(ref);
    for (let tick = 0; tick < 10 && requirement?.status !== "stopped"; tick += 1) {
      await engine.tick();
      requirement = await store.requirementByRef(ref);
    }
    // Two attempts, one rework of the plan, two more attempts: then it is a person's turn.
    expect(requirement).toMatchObject({ status: "stopped", stopReason: "no_progress" });
    expect(requirement?.stopDetail).toContain("item greeting");
    expect(builderRuns).toEqual(["greeting", "greeting", "greeting", "greeting"]);
    const runs = await store.runsOf(requirement?.id ?? "");
    expect(runs.filter((run) => run.step === "revise")).toHaveLength(1);
    expect(JSON.parse(await readFile(join(boardRoot, ref, "status.json"), "utf8"))).toMatchObject({ status: "stopped" });

    await commentLocal(boardRoot, ref, "The greeting must read exactly: hello, world", new Date());
    for (let tick = 0; tick < 6 && requirement?.status !== "waiting"; tick += 1) {
      await engine.tick();
      requirement = await store.requirementByRef(ref);
    }
    expect(requirement?.status).toBe("waiting");
    expect(builderRuns).toHaveLength(5);
    expect((await store.items(requirement?.id ?? "")).map((item) => item.status)).toEqual(["passed"]);
  });
});
