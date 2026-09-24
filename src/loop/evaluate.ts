import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assembleSystemPrompt } from "../agents/prompt.ts";
import type { AgentRun } from "../agents/run.ts";
import type { Contract, ContractScenario, VisibleExpectation } from "../domain/contract.ts";
import type { Project } from "../domain/project.ts";
import { checkVerdict, verdictSchema, type Evidence, type EvidenceMatcher, type JudgedVerdict } from "../domain/verdict.ts";
import { matchOutput, matchVisible } from "../gates/evidence.ts";
import { enforceFence } from "../gates/fence.ts";
import type { CapturedEvidence, ReplayScript, RunningApp } from "../ports.ts";
import type { RequirementRow } from "../store/store.ts";
import { artifactsOf, runSession, sessionLimits, type LoopContext } from "./context.ts";
import { PRODUCT_DIR, productDocuments } from "./product.ts";

/**
 * Gate two: the product is started the way a person starts it and judged
 * against the acceptance contract. Scenarios that passed before are replayed
 * first, without a model, from the scripts recorded when they passed; the
 * scenarios under test are then judged by an evaluator session that drives
 * the product itself and whose every pass must cite a snapshot the harness
 * took. The evaluator cannot change the tree: anything it changed is put back
 * and its verdict is discarded, because it would describe a different tree.
 */

export type Evaluation =
  | { kind: "passed"; verdict: JudgedVerdict | null; scripts: readonly ReplayScript[] }
  /** Product defects, written for the builder. */
  | { kind: "failed"; findings: readonly string[] }
  /** The evaluator could not judge; nothing is known about the product. */
  | { kind: "inconclusive"; reasons: readonly string[] }
  | { kind: "unavailable"; run: Extract<AgentRun<unknown>, { ok: false }> };

export interface EvaluationInput {
  requirement: RequirementRow;
  worktree: string;
  /** The commit being judged; the evaluator's changes are measured against it. */
  candidate: string;
  contract: Contract;
  project: Project;
  itemId: string | null;
  step: string;
  judge: readonly ContractScenario[];
  regression: readonly ContractScenario[];
}

const EVALUATOR_READ_TOOLS = ["read", "grep", "find", "ls"] as const;

export const SCRIPTS_DIR = `${PRODUCT_DIR}/acceptance`;

export async function evaluate(context: LoopContext, input: EvaluationInput): Promise<Evaluation> {
  if (input.judge.length === 0 && input.regression.length === 0) return { kind: "passed", verdict: null, scripts: [] };
  const needsApp = [...input.judge, ...input.regression].some((scenario) => scenario.surface === "web");
  let app: RunningApp | null = null;
  if (needsApp) {
    const declared = input.project.app;
    if (declared === undefined) return { kind: "failed", findings: ["project.yaml declares no app, so the web scenarios cannot be opened"] };
    const started = await context.startApp({
      cwd: input.worktree,
      start: ["bash", "-c", declared.start],
      readyPath: declared.ready,
      env: context.config.childEnv(),
      timeoutMs: declared.timeoutSeconds * 1000,
    });
    if (!started.ok) {
      return {
        kind: "failed",
        findings: [`the product did not start with \`${declared.start}\`: ${started.reason}. Its output ends with:\n${started.output.slice(-3000)}`],
      };
    }
    app = started.app;
  }
  try {
    const regression = await replayPassed(context, input, app);
    if (regression.length > 0) return { kind: "failed", findings: regression };
    if (input.judge.length === 0) return { kind: "passed", verdict: null, scripts: [] };
    return await judge(context, input, app);
  } finally {
    await app?.stop();
  }
}

async function judge(context: LoopContext, input: EvaluationInput, app: RunningApp | null): Promise<Evaluation> {
  const origin = app?.origin ?? "http://127.0.0.1:9";
  const browser = await context.openBrowser({
    origin,
    artifactsDir: artifactsOf(context, input.requirement, `${input.step}-${input.itemId ?? "all"}-${context.now()}`),
    seed: (scenarioId) => seed(context, input, scenarioId, app),
    runCommand: async (command) => {
      const result = await context.run(["bash", "-c", command], { cwd: input.worktree, env: appEnv(context, app), timeoutMs: 5 * 60_000 });
      return { code: result.code, output: `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}` };
    },
  });
  let run: AgentRun<ReturnType<typeof verdictSchema.parse>>;
  try {
    const tools = browser.tools();
    const layers = [await context.prompts.layer("base"), await context.prompts.layer("roles/evaluator"), await context.prompts.layer("steps/evaluate")];
    run = await runSession(context, {
      requirementId: input.requirement.id,
      itemId: input.itemId,
      step: `${input.step}:evaluate`,
      session: {
        role: "evaluator",
        cwd: input.worktree,
        candidates: context.config.models.roles.evaluator,
        systemPrompt: assembleSystemPrompt(layers, await productDocuments(input.worktree)),
        builtinTools: EVALUATOR_READ_TOOLS,
        tools,
        policy: { allowedTools: [...EVALUATOR_READ_TOOLS, ...tools.map((tool) => tool.name), "submit_result"], root: input.worktree, writable: [], fenced: [] },
        env: context.config.childEnv(),
        ...sessionLimits(context, "evaluator"),
      },
      task: evaluatorTask(input.judge),
      result: { schema: verdictSchema, description: "Submit one outcome for every scenario you were given, citing the evidence ids the tools returned." },
      check: (verdict) => {
        const checked = checkVerdict(verdict, input.judge, toEvidence(browser.evidence()), MATCHER);
        return checked.ok ? [] : checked.findings;
      },
      maxHandbacks: context.config.limits.maxHandbacks,
    });
  } finally {
    await browser.close();
  }

  const changed = await enforceFence(context.git, input.worktree, input.candidate, "evaluator");
  if (!run.ok) {
    if (run.reason === "unavailable" || run.needsHuman) return { kind: "unavailable", run };
    return { kind: "inconclusive", reasons: [`the evaluator session did not finish: ${run.detail}`, ...run.findings] };
  }
  if (changed.length > 0) {
    return { kind: "inconclusive", reasons: [`the evaluator changed ${changed.join(", ")}, so its verdict described another tree; the changes were put back`] };
  }
  const checked = checkVerdict(run.value, input.judge, toEvidence(browser.evidence()), MATCHER);
  if (!checked.ok) return { kind: "inconclusive", reasons: checked.findings };
  const verdict = checked.verdict;
  const byId = new Map(input.judge.map((scenario) => [scenario.id, scenario]));
  if (verdict.failed.length > 0) {
    return {
      kind: "failed",
      findings: verdict.failed.map((entry) => {
        const scenario = byId.get(entry.id);
        return `scenario ${entry.id} (${scenario?.title ?? ""}) failed: ${entry.reason}. The contract says: when ${scenario?.when ?? ""}, then ${scenario?.then ?? ""}`;
      }),
    };
  }
  if (verdict.inconclusive.length > 0) return { kind: "inconclusive", reasons: verdict.inconclusive.map((entry) => `${entry.id}: ${entry.reason}`) };
  const scripts = input.judge
    .filter((scenario) => scenario.surface === "web")
    .map((scenario) => browser.script(scenario.id))
    .filter((script): script is ReplayScript => script !== null);
  return { kind: "passed", verdict, scripts };
}

/** Scenarios that passed before, replayed without a model. Any that no longer holds is a regression the builder caused. */
async function replayPassed(context: LoopContext, input: EvaluationInput, app: RunningApp | null): Promise<string[]> {
  const findings: string[] = [];
  for (const scenario of input.regression) {
    const prepared = await seed(context, input, scenario.id, app);
    if (!prepared.ok) {
      findings.push(`scenario ${scenario.id} (passed before) could not be prepared: ${prepared.detail}`);
      continue;
    }
    if (scenario.surface === "cli") {
      const result = await context.run(["bash", "-c", scenario.command ?? ""], { cwd: input.worktree, env: appEnv(context, app), timeoutMs: 5 * 60_000 });
      const matched = matchOutput(`${result.stdout}\n${result.stderr}`, scenario.visible);
      if (!matched.ok) findings.push(`scenario ${scenario.id} (${scenario.title}) passed before and now fails: \`${scenario.command ?? ""}\` no longer shows ${describe(matched.missing)}`);
      continue;
    }
    const script = await readScript(input.worktree, scenario.id);
    if (script === null || app === null) continue;
    const replayed = await context.replay({ origin: app.origin, script });
    if (!replayed.ok) {
      findings.push(`scenario ${scenario.id} (${scenario.title}) passed before and its recorded steps now fail: ${replayed.detail}`);
      continue;
    }
    const matched = matchVisible(replayed.snapshot, scenario.visible);
    if (!matched.ok) findings.push(`scenario ${scenario.id} (${scenario.title}) passed before and ${scenario.page ?? ""} no longer shows ${describe(matched.missing)}`);
  }
  return findings;
}

export async function saveScripts(worktree: string, scripts: readonly ReplayScript[]): Promise<void> {
  for (const script of scripts) {
    const path = join(worktree, SCRIPTS_DIR, `${script.scenarioId}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(script, null, 2)}\n`);
  }
}

async function readScript(worktree: string, scenarioId: string): Promise<ReplayScript | null> {
  try {
    return JSON.parse(await readFile(join(worktree, SCRIPTS_DIR, `${scenarioId}.json`), "utf8")) as ReplayScript;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function seed(context: LoopContext, input: EvaluationInput, scenarioId: string, app: RunningApp | null): Promise<{ ok: true } | { ok: false; detail: string }> {
  const scenario = [...input.judge, ...input.regression].find((entry) => entry.id === scenarioId);
  if (scenario === undefined) return { ok: false, detail: `${scenarioId} is not one of the scenarios being judged` };
  if (scenario.seed === undefined) return { ok: true };
  const command = input.project.app?.seed;
  if (command === undefined) return { ok: false, detail: `scenario ${scenarioId} needs seed "${scenario.seed}" but project.yaml declares no app.seed command` };
  const result = await context.run(["bash", "-c", command.replaceAll("{seed}", scenario.seed)], { cwd: input.worktree, env: appEnv(context, app), timeoutMs: 2 * 60_000 });
  if (result.code === 0) return { ok: true };
  return { ok: false, detail: `seed "${scenario.seed}" failed: ${`${result.stdout}\n${result.stderr}`.trim().slice(-2000)}` };
}

function appEnv(context: LoopContext, app: RunningApp | null): Record<string, string> {
  return context.config.childEnv(app === null ? {} : { PORT: String(app.port), APP_ORIGIN: app.origin });
}

function evaluatorTask(scenarios: readonly ContractScenario[]): string {
  const listed = scenarios.map((scenario) => {
    const where = scenario.surface === "web" ? `page ${scenario.page ?? ""}` : `command \`${scenario.command ?? ""}\``;
    const visible = scenario.visible.map((entry) => [entry.role, entry.text === undefined ? undefined : `"${entry.text}"`].filter(Boolean).join(" ")).join("; ");
    return [`### ${scenario.id} ${scenario.title} (${where})`, `Given: ${scenario.given}`, `When: ${scenario.when}`, `Then: ${scenario.then}`, `Must be visible: ${visible}`].join("\n");
  });
  return `Judge each of these scenarios on the running product. Call begin_scenario before working on one, and take a snapshot on its page once its outcome is visible.\n\n${listed.join("\n\n")}`;
}

function toEvidence(captured: ReadonlyMap<string, CapturedEvidence>): Map<string, Evidence> {
  const evidence = new Map<string, Evidence>();
  for (const [id, entry] of captured) {
    if (entry.kind === "snapshot") evidence.set(id, { id, kind: "snapshot", path: entry.path, text: entry.text });
    else if (entry.kind === "output") evidence.set(id, { id, kind: "output", command: entry.command, text: entry.text });
    else evidence.set(id, { id, kind: "screenshot", path: entry.path });
  }
  return evidence;
}

function describe(missing: readonly VisibleExpectation[]): string {
  return missing.map((entry) => [entry.role, entry.text === undefined ? undefined : `"${entry.text}"`].filter(Boolean).join(" ")).join(", ");
}

const MATCHER: EvidenceMatcher = {
  matchSnapshot: (text, scenario) => {
    const matched = matchVisible(text, scenario.visible);
    return { ok: matched.ok, missing: matched.missing.map((entry) => describe([entry])) };
  },
  matchOutput: (text, scenario) => {
    const matched = matchOutput(text, scenario.visible);
    return { ok: matched.ok, missing: matched.missing.map((entry) => describe([entry])) };
  },
};
