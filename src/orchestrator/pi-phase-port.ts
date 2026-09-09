import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  POLICY_ENV_VAR,
  assembleGuardPolicy,
  serializeGuardPolicy,
} from "../guard/policy.js";
import {
  collectCodeExitFacts,
  evaluateCodeExit,
  renderCodeExitFindings,
  type CodeExitFacts,
  type ProjectCheck,
} from "../pipeline/code-exit-gate.js";
import { CANONICAL_CAPTURE_ENV } from "../observability/capture-contract.js";
import { loadPromptLayers } from "../pipeline/prompt-loader.js";
import {
  lintBusinessLanguage,
  renderBusinessLanguageFindings,
} from "../report/business-language.js";
import { lastAssistantText } from "../runner/assistant-text.js";
import { jsonPayloadCandidates } from "../util/json-payload.js";
import { loadExplicitContextBundle, type ExplicitContextFile } from "../runner/context-files.js";
import { promptWithContinueRetry } from "../runner/continue-retry.js";
import type { ResolvedModel } from "../runner/model-resolver.js";
import { RpcPiRunner, type RpcRunnerConfig } from "../runner/rpc-runner.js";
import type { PiRunner, PromptResult } from "../runner/types.js";
import type {
  ManagedPhaseInput,
  ManagedPhaseResult,
  StoryPhasePort,
} from "./story-worker.js";
import type { StoryPhase } from "./story-execution-store.js";

const designResult = z.object({
  design_summary: z.string().trim().min(1),
  dod_yaml: z.string().trim().min(1),
}).strict();
const codeResult = z.object({ implementation: z.string().trim().min(1) }).strict();
const mergeResult = z.object({ delivery_report: z.string().trim().min(1) }).strict();

export interface PhaseTelemetryInput {
  runId: string;
  cardId: string;
  phase: StoryPhase;
  messages: unknown[];
  result: PromptResult;
  providerPayloads: unknown[];
}

const execFileAsync = promisify(execFile);

const WRITING_PHASES = new Set<ManagedPhaseInput["phase"]>(["CODE", "REGRESSION_FIX"]);

/** How the deterministic CODE exit is measured for this repository. */
export interface CodeExitOptions {
  /** Branch the Story is landing on, the base of its own commits. */
  baseRef: string;
  /** The repository's own gate commands, declared in config rather than here:
   * hivemind does not get to decide how somebody else's repository is checked. */
  projectChecks: readonly ProjectCheck[];
  /** How many times the findings are handed back before the phase gives up.
   * The findings cost no round and no reentry, but the loop is still bounded:
   * a session that cannot satisfy a deterministic check in this many tries is
   * not going to. */
  maxRounds?: number;
}

const DEFAULT_CODE_EXIT_ROUNDS = 3;
const DEFAULT_REPORT_REWRITES = 2;

/** A CODE exit that never satisfied its checks. Carries the findings so the
 * next round starts from them instead of from a bare failure message. */
export class CodeExitNotMetError extends Error {
  constructor(readonly findings: readonly string[]) {
    super(`CODE exit checks were not met: ${findings.join(" | ")}`);
    this.name = "CodeExitNotMetError";
  }
}

export interface PiStoryPhasePortOptions {
  binary: string;
  model: ResolvedModel;
  worktreePath: string;
  promptRoot: string;
  sessionRoot: string;
  evidencePath: string;
  auditPath: string;
  guardExtension: string;
  canonicalCaptureExtension: string;
  /** Present for writing phases; absent leaves the phase with output parsing
   * as its only exit check, which is all a read-only phase has to prove. */
  codeExit?: CodeExitOptions;
  contextFiles?: ExplicitContextFile[];
  /** Hosts a browser-driving phase may navigate to; from guard.e2eHostAllowlist. */
  e2eHostAllowlist?: string[];
  extensions?: string[];
  env?: Record<string, string>;
  maxContinueRetries?: number;
  /** Wall clock for one prompt; a turn that outruns it is resumed, not failed. */
  promptTimeoutMs?: number;
  /** How many rewrites the delivery report gets before it ships as written. */
  maxReportRewrites?: number;
  createRunner?: (config: RpcRunnerConfig) => PiRunner;
  recordTelemetry?: (input: PhaseTelemetryInput) => Promise<void>;
  readProviderPayloads?: (path: string) => Promise<unknown[]>;
  /** Measures the CODE exit; defaults to git plus the declared checks. */
  collectExitFacts?: (options: CodeExitOptions, dodScenarioIds: readonly string[]) => Promise<CodeExitFacts>;
}

/** Collects JSON payloads the model may have wrapped in prose or a code fence.
 * Schema validation below decides whether a candidate is the real phase result. */
function parseArtifacts(input: ManagedPhaseInput, value: unknown): ManagedPhaseResult["artifacts"] {
  switch (input.phase) {
    case "DESIGN": {
      const candidate = value as { design_summary?: unknown; dod_yaml?: unknown };
      const parsed = designResult.parse({ ...candidate, dod_yaml: normalizeDodYaml(candidate.dod_yaml) });
      return [
        { kind: "design-summary", body: parsed.design_summary },
        { kind: "dod", body: parsed.dod_yaml },
      ];
    }
    case "CODE":
    case "REGRESSION_FIX":
      return [{ kind: "implementation", body: codeResult.parse(value).implementation }];
    case "MERGE":
      return [{ kind: "delivery-report", body: mergeResult.parse(value).delivery_report }];
  }
}

function parseResult(input: ManagedPhaseInput, raw: string): ManagedPhaseResult["artifacts"] {
  const candidates = jsonPayloadCandidates(raw);
  if (candidates.length === 0) {
    throw new Error(`${input.phase} returned invalid JSON`);
  }
  let lastCause: unknown;
  for (const candidate of candidates) {
    try {
      return parseArtifacts(input, candidate);
    } catch (cause) {
      lastCause = cause;
    }
  }
  throw new Error(`${input.phase} response contained no structurally valid payload`, { cause: lastCause });
}

/** Models occasionally inline the DoD as a nested object or hide a string
 * criterion inside a labelled object; serialise both back to the string form
 * the frozen contract requires without changing their content. */
function normalizeDodYaml(raw: unknown): string {
  if (raw === null || (typeof raw !== "object" && typeof raw !== "string")) return String(raw);
  try {
    const document = typeof raw === "string"
      ? (parse(raw) as Record<string, unknown>)
      : { ...(raw as Record<string, unknown>) };
    if (Array.isArray(document.acceptance_criteria)) {
      document.acceptance_criteria = document.acceptance_criteria.map((item) => flattenToString(item));
    }
    return stringify(document);
  } catch {
    // Not YAML after all; leave the original for schema validation to judge.
    return typeof raw === "string" ? raw : String(raw);
  }
}

/** Flattens a criterion to the one-line string form the DoD contract requires.
 * Nesting is descended into: a criterion that collapsed to "[object Object]"
 * would still satisfy the schema and freeze as the Story's acceptance text. */
function flattenToString(item: unknown): string {
  if (typeof item === "string") return item;
  if (item === null || item === undefined) return "";
  if (Array.isArray(item)) return item.map((entry) => flattenToString(entry)).filter(Boolean).join("; ");
  if (typeof item === "object") {
    return Object.entries(item)
      .map(([key, value]) => `${key}: ${flattenToString(value)}`)
      .join("; ");
  }
  return String(item);
}

function sessionId(state: Record<string, unknown>): string {
  const value = state.sessionFile ?? state.sessionId;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("phase runner did not expose a session identifier");
  }
  return value;
}

function toolsFor(phase: ManagedPhaseInput["phase"]): string[] {
  return phase === "CODE" || phase === "REGRESSION_FIX"
    ? ["read", "bash", "edit", "write"]
    : ["read", "bash"];
}

async function readProviderPayloads(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

/** Real pi-backed phase port with guard injection, strict output parsing and completion judgment. */
export class PiStoryPhasePort implements StoryPhasePort {
  private readonly createRunner: (config: RpcRunnerConfig) => PiRunner;

  constructor(private readonly options: PiStoryPhasePortOptions) {
    this.createRunner = options.createRunner ?? ((config) => new RpcPiRunner(config));
  }

  async run(input: ManagedPhaseInput): Promise<ManagedPhaseResult> {
    const [layers, context] = await Promise.all([
      loadPromptLayers(this.options.promptRoot, input.phase),
      loadExplicitContextBundle(this.options.contextFiles ?? []),
    ]);
    const systemPrompt = `${layers.combined}${context.text}`;
    const tools = toolsFor(input.phase);
    const sessionDir = join(this.options.sessionRoot, input.runId);
    const runEvidencePath = join(this.options.evidencePath, input.runId);
    const capturePath = join(runEvidencePath, "provider-requests.jsonl");
    await Promise.all([
      mkdir(sessionDir, { recursive: true }),
      mkdir(runEvidencePath, { recursive: true }),
      mkdir(dirname(this.options.auditPath), { recursive: true }),
    ]);
    const policy = assembleGuardPolicy({
      phase: input.phase,
      cardId: input.context.cardId,
      runId: input.runId,
      worktreePath: this.options.worktreePath,
      evidencePath: this.options.evidencePath,
      auditPath: this.options.auditPath,
      ...(this.options.e2eHostAllowlist ? { e2eHostAllowlist: this.options.e2eHostAllowlist } : {}),
    });
    const runner = this.createRunner({
      binary: this.options.binary,
      provider: this.options.model.provider,
      model: this.options.model,
      cwd: this.options.worktreePath,
      sessionDir,
      tools,
      extensions: [
        ...(this.options.extensions ?? []),
        this.options.guardExtension,
        this.options.canonicalCaptureExtension,
      ],
      contextFiles: "explicit",
      systemPrompt: { mode: "replace", text: systemPrompt },
      env: {
        ...this.options.env,
        [POLICY_ENV_VAR]: serializeGuardPolicy(policy),
        [CANONICAL_CAPTURE_ENV]: capturePath,
      },
    });

    try {
      await runner.start();
      await runner.setAutoRetry(false);
      const phaseSessionId = sessionId(await runner.getState());
      const result = await promptWithContinueRetry(
        runner,
        input.prompt,
        { maxContinueRetries: this.options.maxContinueRetries ?? 8 },
        this.options.promptTimeoutMs,
      );
      if (result.failure) throw new Error(result.failure.errorMessage);
      const messages = await runner.getMessages();
      const providerPayloads = await (this.options.readProviderPayloads ?? readProviderPayloads)(capturePath);
      if (providerPayloads.length === 0) throw new Error("phase provider request was not captured");
      let artifacts = parseResult(input, lastAssistantText(messages));
      const codeExit = this.options.codeExit;
      if (codeExit && WRITING_PHASES.has(input.phase)) {
        artifacts = await this.enforceCodeExit(input, runner, codeExit, artifacts);
      }
      if (input.phase === "MERGE") {
        artifacts = await this.rewriteUntilReadable(input, runner, artifacts);
      }
      await this.options.recordTelemetry?.({
        runId: input.runId,
        cardId: input.context.cardId,
        phase: input.phase,
        messages,
        result,
        providerPayloads,
      });
      return { sessionId: phaseSessionId, artifacts };
    } finally {
      await runner.stop().catch(() => undefined);
    }
  }

  /**
   * The deterministic CODE exit, in place of a model judging whether the phase
   * it just ran is finished. Findings are handed back to the same live session:
   * they are a work item, not a verdict on the Story, so they cost no round and
   * no reentry and reuse everything the session has already loaded.
   */
  private async enforceCodeExit(
    input: ManagedPhaseInput,
    runner: PiRunner,
    options: CodeExitOptions,
    artifacts: ManagedPhaseResult["artifacts"],
  ): Promise<ManagedPhaseResult["artifacts"]> {
    const dodScenarioIds = input.context.specs.map((spec) => spec.id);
    const collect = this.options.collectExitFacts ?? ((gate, scenarioIds) => this.measureCodeExit(gate, scenarioIds));
    const maxRounds = options.maxRounds ?? DEFAULT_CODE_EXIT_ROUNDS;
    let current = artifacts;
    for (let attempt = 1; ; attempt++) {
      const verdict = evaluateCodeExit(await collect(options, dodScenarioIds));
      if (verdict.passed) return current;
      if (attempt >= maxRounds) throw new CodeExitNotMetError(verdict.findings);
      const result = await promptWithContinueRetry(
        runner,
        renderCodeExitFindings(verdict),
        { maxContinueRetries: this.options.maxContinueRetries ?? 8 },
        this.options.promptTimeoutMs,
      );
      if (result.failure) throw new Error(result.failure.errorMessage);
      current = parseResult(input, lastAssistantText(await runner.getMessages()));
    }
  }

  /**
   * Asks MERGE to rewrite a report whose business section reads like a
   * transcript. MERGE has no veto over the Story (section 8.2), so a report
   * that is still technical after its rewrites ships as written: what people
   * read is worth a retry, never a stalled card.
   */
  private async rewriteUntilReadable(
    input: ManagedPhaseInput,
    runner: PiRunner,
    artifacts: ManagedPhaseResult["artifacts"],
  ): Promise<ManagedPhaseResult["artifacts"]> {
    const maxRewrites = this.options.maxReportRewrites ?? DEFAULT_REPORT_REWRITES;
    let current = artifacts;
    for (let attempt = 0; attempt < maxRewrites; attempt++) {
      const report = current.find((item) => item.kind === "delivery-report")?.body ?? "";
      const findings = lintBusinessLanguage(report);
      if (findings.length === 0) return current;
      const result = await promptWithContinueRetry(
        runner,
        renderBusinessLanguageFindings(findings),
        { maxContinueRetries: this.options.maxContinueRetries ?? 8 },
        this.options.promptTimeoutMs,
      );
      if (result.failure) throw new Error(result.failure.errorMessage);
      current = parseResult(input, lastAssistantText(await runner.getMessages()));
    }
    return current;
  }

  private async measureCodeExit(
    options: CodeExitOptions,
    dodScenarioIds: readonly string[],
  ): Promise<CodeExitFacts> {
    const worktreePath = this.options.worktreePath;
    return collectCodeExitFacts({
      git: {
        run: async (args) => (await execFileAsync("git", [...args], {
          cwd: worktreePath,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        })).stdout,
      },
      readWorktreeFile: (path) => readFile(join(worktreePath, path), "utf8"),
      runCheck: async (check) => {
        const [command, ...args] = check.command;
        try {
          const done = await execFileAsync(command!, args, {
            cwd: worktreePath,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            env: process.env,
          });
          return { passed: true, detail: tail(done.stdout) };
        } catch (cause) {
          const output = `${(cause as { stdout?: string }).stdout ?? ""}${(cause as { stderr?: string }).stderr ?? ""}`;
          return { passed: false, detail: tail(output === "" ? (cause as Error).message : output) };
        }
      },
      baseRef: options.baseRef,
      dodScenarioIds,
      projectChecks: options.projectChecks,
    });
  }
}

/** Check output is for a person and for the next CODE round; the failing tail
 * is where a runner puts its summary. */
function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= 2000 ? trimmed : `...\n${trimmed.slice(-2000)}`;
}
