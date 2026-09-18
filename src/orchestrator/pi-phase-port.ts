import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { dirname, join } from "node:path";
import {
  POLICY_ENV_VAR,
  assembleGuardPolicy,
  serializeGuardPolicy,
} from "../guard/policy.js";
import { roundTasks } from "../pipeline/phase-input.js";
import {
  collectCodeExitFacts,
  evaluateCodeExit,
  renderCodeExitFindings,
  type CodeExitFacts,
  type ProjectCheck,
} from "../pipeline/code-exit-gate.js";
import { CANONICAL_CAPTURE_ENV } from "../observability/capture-contract.js";
import { loadPromptLayers } from "../pipeline/prompt-loader.js";
import { phaseContract } from "../pipeline/phase-contract.js";
import { fencedSourcesFor } from "../pipeline/path-glob.js";
import { PHASE_LANE, type ModelPurpose } from "../pipeline/phase.js";
import { pinSessionFile, type CacheKeyScope } from "../runner/session-file.js";
import type { ResolvedAgentSpec } from "../runner/agent-spec.js";
import type { AgentSpawnGrant } from "../runner/spawn-broker.js";
import {
  lintBusinessLanguage,
  lintHumanSentence,
  renderBusinessLanguageFindings,
  renderDesignSummaryFindings,
  type BusinessLanguageFinding,
} from "../report/business-language.js";
import { lastAssistantText } from "../runner/assistant-text.js";
import { jsonPayloadCandidates } from "../util/json-payload.js";
import { loadExplicitContextBundle, type ExplicitContextFile } from "../runner/context-files.js";
import { promptWithContinueRetry } from "../runner/continue-retry.js";
import { RpcPiRunner, type RpcRunnerConfig } from "../runner/rpc-runner.js";
import type { PiRunner, PromptResult } from "../runner/types.js";
import type {
  ManagedPhaseInput,
  PhaseExitGate,
  ManagedPhaseResult,
  StoryPhasePort,
} from "./story-worker.js";
import type { StoryPhase } from "./story-execution-store.js";
import { emitSafely } from "../observability/emit-safely.js";

/** What the ledger wrote, carried into the evidence log so it is not written
 * twice. Structural rather than imported, to keep the port free of the
 * observability module. */
export interface PhaseCostRow {
  data: unknown;
}

export interface PhaseTelemetryInput {
  runId: string;
  cardId: string;
  phase: StoryPhase;
  messages: unknown[];
  result: PromptResult;
  providerPayloads: unknown[];
  /** What this execution ran on; the cost row is attributed from it. */
  spec: ResolvedAgentSpec;
}

const execFileAsync = promisify(execFile);

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
  /** What counts as a test path in this repository. */
  testPathPatterns?: readonly string[] | undefined;
  /** Generated outputs no phase may edit by hand. */
  protectedPaths?: readonly string[] | undefined;
  /** The commit SPECIFY froze the tests in; the base of the frozen-test diff.
   * Absent on a card driven without SPECIFY, which then rests on the checks
   * that still apply. */
  frozenTestCommit?: string | undefined;
}

/** The phases the CODE exit is about. */
const IMPLEMENTING_PHASES = new Set<string>(["CODE", "REGRESSION_FIX"]);

const DEFAULT_CODE_EXIT_ROUNDS = 3;
const DEFAULT_REPORT_REWRITES = 2;

/** A phase exit that its own session could not satisfy. Carries the findings
 * so the next attempt starts from them instead of from a bare failure. */
export class PhaseExitNotMetError extends Error {
  constructor(phase: string, readonly findings: string) {
    super(`${phase} exit checks were not met: ${findings}`);
    this.name = "PhaseExitNotMetError";
  }
}

/** A CODE exit that never satisfied its checks. Carries the findings so the
 * next round starts from them instead of from a bare failure message. */
export class CodeExitNotMetError extends PhaseExitNotMetError {
  constructor(readonly codeFindings: readonly string[]) {
    super("CODE", codeFindings.join(" | "));
    this.name = "CodeExitNotMetError";
  }
}

export interface PiStoryPhasePortOptions {
  binary: string;
  /**
   * Everything about this spawn that configuration decides, resolved through
   * `resolveAgentSpec` once per phase rather than once per process.
   *
   * Per phase, because the purpose changes with the phase and so do the tier,
   * the reasoning effort, the provider the failover chain picks and therefore
   * the price and the billing. Resolving once at startup is what made a card
   * run every phase on the CODE tier, and what left a subscription-started
   * card with no spend ceiling after it failed over to a metered API.
   *
   * It carries the model, so a caller that only read `.id` off a model -- the
   * shape that dropped tier and effort on the floor -- no longer compiles.
   */
  resolveSpec: (purpose: ModelPurpose) => Promise<AgentSpawnGrant>;
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
  /** The credential a spawn needs for the provider it was granted. Resolved
   * per phase, so it cannot be part of the static env above: a card that fails
   * over mid-run would spawn on the second provider with the first one's key. */
  providerEnv?: (provider: string) => Record<string, string>;
  maxContinueRetries?: number;
  /** Wall clock for one prompt; a turn that outruns it is resumed, not failed. */
  promptTimeoutMs?: number;
  /** How many rewrites the delivery report gets before it ships as written. */
  maxReportRewrites?: number;
  /** What a provider cache key groups; from `cache.keyScope`. */
  cacheKeyScope?: CacheKeyScope;
  /** Grouping value when the scope is a repository. */
  repoId?: string;
  createRunner?: (config: RpcRunnerConfig) => PiRunner;
  /** The cost row. Execution state, not observation: the per-card ceiling is a
   * real stop point derived from it, so this one is awaited and a failure to
   * write it fails the phase. */
  recordCost?: (input: PhaseTelemetryInput) => Promise<PhaseCostRow | void>;
  /** Ring 0. Synchronous, no I/O, never throws; everything a reader wants
   * afterwards is written by the drain loop from what this enqueues. Replacing
   * it with an empty function must leave the pipeline compiling and behaving
   * exactly as it does now -- that is the test that it stayed a side channel. */
  emit?: (type: string, data: unknown) => void;
  readProviderPayloads?: (path: string) => Promise<unknown[]>;
  /** Measures the CODE exit; defaults to git plus the declared checks. */
  collectExitFacts?: (options: CodeExitOptions, dodScenarioIds: readonly string[]) => Promise<CodeExitFacts>;
}

/** Collects JSON payloads the model may have wrapped in prose or a code fence.
 * The phase contract decides whether a candidate is the real phase result. */
function parseArtifacts(input: ManagedPhaseInput, value: unknown): ManagedPhaseResult["artifacts"] {
  const candidate = value as Record<string, unknown>;
  // Models write the frozen contract as a nested object or escape it twice;
  // both are repaired back to the form the schema requires before it judges.
  const repaired = typeof candidate === "object" && candidate !== null && "dod_yaml" in candidate
    ? { ...candidate, dod_yaml: normalizeDodYaml(candidate.dod_yaml) }
    : candidate;
  return phaseContract(input.phase).parse(repaired);
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

/** Models occasionally inline the DoD as a nested object or hide a criterion's
 * text inside a labelled object; serialise both back to the form the frozen
 * contract requires without changing their content. A criterion is kept when
 * it already has the contract's shape, and otherwise reduced to its text so
 * the schema's refusal names the criterion rather than "[object Object]". */
/** A YAML document the model escaped twice arrives as one line holding the
 * two characters backslash and n where each line break should be. */
function unescapeLineBreaks(text: string): string {
  if (text.includes("\n") || !text.includes("\\n")) return text;
  return text.replaceAll("\\n", "\n").replaceAll("\\t", "  ");
}

/**
 * Quotes the plain scalars a model most often leaves bare: a value holding
 * ": " (YAML reads it as a nested mapping) or starting with a character YAML
 * gives a meaning to. Applied only after the document failed to parse, line by
 * line, and only to `key: value` lines whose value is not already quoted or a
 * block indicator; anything else is left exactly as written.
 */
function quoteBareScalars(text: string): string {
  return text.split("\n").map((line) => {
    const match = /^(\s*(?:- )?[A-Za-z_][\w-]*): (.+)$/.exec(line);
    if (!match) return line;
    const [, key, value] = match as unknown as [string, string, string];
    if (/^["'|>[{]/.test(value) || /^-?\d+(\.\d+)?$/.test(value) || /^(true|false|null)$/.test(value)) return line;
    const risky = value.includes(": ") || value.endsWith(":") || /^[@`*&!%#]/.test(value);
    if (!risky) return line;
    return `${key}: ${JSON.stringify(value)}`;
  }).join("\n");
}

function parseLeniently(text: string): Record<string, unknown> {
  const unescaped = unescapeLineBreaks(text);
  try {
    return parse(unescaped) as Record<string, unknown>;
  } catch (cause) {
    const repaired = quoteBareScalars(unescaped);
    if (repaired === unescaped) throw cause;
    return parse(repaired) as Record<string, unknown>;
  }
}

function normalizeDodYaml(raw: unknown): string {
  if (raw === null || (typeof raw !== "object" && typeof raw !== "string")) return String(raw);
  try {
    const document = typeof raw === "string"
      ? parseLeniently(raw)
      : { ...(raw as Record<string, unknown>) };
    if (Array.isArray(document.acceptance_criteria)) {
      document.acceptance_criteria = document.acceptance_criteria.map((item) => normalizeCriterion(item));
    }
    return stringify(document);
  } catch {
    // Not YAML after all; leave the original for schema validation to judge.
    return typeof raw === "string" ? raw : String(raw);
  }
}

function normalizeCriterion(item: unknown): unknown {
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string" && ("scenarios" in record || "constraint" in record)) return record;
    const { scenarios, constraint, ...rest } = record;
    const text = flattenToString(Object.keys(rest).length > 0 ? rest : record);
    return { text, ...(scenarios !== undefined ? { scenarios } : {}), ...(constraint !== undefined ? { constraint } : {}) };
  }
  return { text: flattenToString(item) };
}

/** Flattens a criterion to one line. Nesting is descended into: a criterion
 * that collapsed to "[object Object]" would freeze as the Story's acceptance text. */
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
    const contract = phaseContract(input.phase);
    // The grant carries the provider capacity this spawn holds; releasing it in
    // the same `finally` as the runner is what makes a failover to another
    // provider hand the first one's slot back instead of leaking it.
    const grant = await this.options.resolveSpec(contract.purpose);
    const spec = grant.spec;
    const [layers, context] = await Promise.all([
      loadPromptLayers(this.options.promptRoot, input.phase),
      loadExplicitContextBundle(this.options.contextFiles ?? []),
    ]);
    // Most stable first. The repository context is the largest block and the
    // one that does not change between phases, so putting it behind the
    // per-phase layer left the shared prefix at the baseline's few hundred
    // bytes and re-billed the context on every phase. Configuration may
    // replace the phase layer or append to it; both sit after the context so
    // that editing either leaves the prefix intact.
    const phaseLayer = spec.prompt.text ?? layers.phase.trim();
    const appended = spec.prompt.append ? `\n\n${spec.prompt.append.trim()}` : "";
    const systemPrompt = `${layers.baseline.trim()}\n\n${context.text}${phaseLayer}${appended}\n`;
    const tools = [...spec.tools];
    const session = await pinSessionFile({
      sessionRoot: this.options.sessionRoot,
      cardId: input.context.cardId,
      phase: input.phase,
      round: input.context.round,
      attempt: input.attempt ?? 1,
      lane: PHASE_LANE[input.phase],
      scope: this.options.cacheKeyScope ?? "card",
      ...(this.options.repoId ? { repoId: this.options.repoId } : {}),
    }, { resuming: input.resuming ?? false });
    const sessionDir = join(this.options.sessionRoot, input.runId);
    const runEvidencePath = join(this.options.evidencePath, input.runId);
    const capturePath = join(runEvidencePath, "provider-requests.jsonl");
    await Promise.all([
      mkdir(sessionDir, { recursive: true }),
      mkdir(runEvidencePath, { recursive: true }),
      mkdir(dirname(this.options.auditPath), { recursive: true }),
    ]);
    // The database keeps only the prompt's hash; the text itself lives beside
    // the session so a round can be read, diffed and replayed after the fact.
    await Promise.all([
      writeFile(join(sessionDir, "prompt.md"), input.prompt),
      writeFile(join(sessionDir, "system-prompt.md"), systemPrompt),
    ]);
    const policy = assembleGuardPolicy({
      phase: input.phase,
      cardId: input.context.cardId,
      runId: input.runId,
      worktreePath: this.options.worktreePath,
      evidencePath: this.options.evidencePath,
      auditPath: this.options.auditPath,
      // The tests SPECIFY froze are fenced for the phases that implement
      // against them. The guard is the entrance; the exit diffs them again,
      // because a fence made of shell write patterns cannot claim to have
      // enumerated every way a file gets written.
      fencedPatterns: [
        ...(spec.guard.fencedPatterns ?? []),
        ...(IMPLEMENTING_PHASES.has(input.phase)
          ? fencedSourcesFor(this.options.codeExit?.testPathPatterns ?? [])
          : []),
      ],
      ...(spec.guard.e2eHostAllowlist ?? this.options.e2eHostAllowlist
        ? { e2eHostAllowlist: spec.guard.e2eHostAllowlist ?? this.options.e2eHostAllowlist ?? [] }
        : {}),
    });
    const runner = this.createRunner({
      binary: this.options.binary,
      provider: spec.model.provider,
      model: spec.model,
      cwd: this.options.worktreePath,
      sessionDir,
      sessionFile: session.path,
      tools,
      skillDiscovery: "explicit",
      skills: [...spec.skills],
      extensions: [
        ...(this.options.extensions ?? []),
        this.options.guardExtension,
        this.options.canonicalCaptureExtension,
      ],
      contextFiles: "explicit",
      systemPrompt: { mode: "replace", text: systemPrompt },
      env: {
        ...this.options.env,
        ...this.options.providerEnv?.(spec.model.provider),
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
        { maxContinueRetries: spec.limits.maxContinueRetries ?? this.options.maxContinueRetries ?? 8 },
        spec.limits.promptTimeoutMs ?? this.options.promptTimeoutMs,
      );
      if (result.failure) throw new Error(result.failure.errorMessage);
      const messages = await runner.getMessages();
      const providerPayloads = await (this.options.readProviderPayloads ?? readProviderPayloads)(capturePath);
      if (providerPayloads.length === 0) throw new Error("phase provider request was not captured");
      // Every exit is the same mechanism: judge what the session produced, and
      // hand the findings back to that same session. A refusal is a work item,
      // not a verdict on the Story, so it costs no round and no reentry and
      // reuses everything the session has already loaded. Refusing into a new
      // session instead cost S-AGENTRULES-01 two phase runs and then the card.
      const gates = [...this.builtInGates(input), ...(input.exitGates ?? [])];
      const enforced = await this.runExitGates(input, runner, gates, parseResult(input, lastAssistantText(messages)));
      let artifacts = enforced.artifacts;
      const exitGateRounds = Object.keys(enforced.rounds).length > 0 ? enforced.rounds : undefined;
      const telemetry: PhaseTelemetryInput = {
        runId: input.runId,
        cardId: input.context.cardId,
        phase: input.phase,
        messages,
        result,
        providerPayloads,
        // The spec this execution actually ran on, not the one the process
        // started with: purpose, tier, provider and billing are all per
        // execution once the provider is resolved per phase.
        spec,
      };
      const cost = await this.options.recordCost?.(telemetry);
      emitSafely(this.options.emit, { ...telemetry, ...(cost ? { cost: cost.data } : {}) });
      return {
        sessionId: phaseSessionId, artifacts, spec,
        ...(exitGateRounds === undefined ? {} : { exitGateRounds }),
      };
    } finally {
      await runner.stop().catch(() => undefined);
      await grant.release().catch(() => undefined);
    }
  }

  /**
   * The exits this port owns, per phase.
   *
   * One table rather than a ladder of `if (phase === ...)`: every phase that
   * gains an exit adds a row, and the mechanism that enforces it is the same
   * one every other row gets. The exits a caller owns -- SPECIFY's contract,
   * SHAPE's definition of done -- arrive through `exitGates` because they need
   * state the port does not have.
   */
  private builtInGates(input: ManagedPhaseInput): PhaseExitGate[] {
    const gates: PhaseExitGate[] = [];
    const codeExit = this.options.codeExit;
    // Only the phases that produce an implementation. DESIGN and SPECIFY also
    // write the worktree, but their exits are different questions entirely --
    // asking a phase that must leave its tests failing for green evidence
    // would refuse every correct SPECIFY.
    if (codeExit && IMPLEMENTING_PHASES.has(input.phase)) {
      const dodScenarioIds = input.context.specs.map((spec) => spec.id);
      const roundTags = roundTasks(input.context).map((task) => task.tag);
      const collect = this.options.collectExitFacts ?? ((gate, scenarioIds) => this.measureCodeExit(gate, scenarioIds));
      let refused: readonly string[] = [];
      gates.push({
        name: "code-exit",
        maxRounds: codeExit.maxRounds ?? DEFAULT_CODE_EXIT_ROUNDS,
        exhausted: "fail",
        // The findings survive as a list rather than one string: the round that
        // follows is told which checks failed, not that some did.
        failure: () => new CodeExitNotMetError(refused),
        evaluate: async (artifacts) => {
          const artifactText = artifacts.map((item) => item.body).join("\n");
          const verdict = evaluateCodeExit({ ...(await collect(codeExit, dodScenarioIds)), roundTags, artifactText });
          if (verdict.passed) return { passed: true };
          refused = verdict.findings;
          return { passed: false, findings: renderCodeExitFindings(verdict) };
        },
      });
    }
    if (input.phase === "MERGE") {
      gates.push(this.readabilityGate(
        "delivery-report", "delivery-report",
        (body) => lintBusinessLanguage(body),
        renderBusinessLanguageFindings,
      ));
    }
    // The design summary is the only part of DESIGN a person reads, and they
    // read it in their own language. The notes for whoever writes the code are
    // a separate artifact and are not held to this.
    if (input.phase === "DESIGN") {
      gates.push(this.readabilityGate(
        "design-summary", "design-summary",
        (body) => lintHumanSentence("design_summary", body),
        renderDesignSummaryFindings,
      ));
    }
    return gates;
  }

  /**
   * An artifact a person reads, held to their language.
   *
   * It ships when the rewrites run out: neither MERGE nor DESIGN has a veto
   * over the Story, and a card stalled over prose is a worse outcome than
   * prose that reads technically.
   */
  private readabilityGate(
    name: string,
    kind: string,
    lint: (body: string) => BusinessLanguageFinding[],
    render: (findings: readonly BusinessLanguageFinding[]) => string,
  ): PhaseExitGate {
    return {
      name,
      // One more than the rewrites allowed: the last rewrite is still judged,
      // and a gate that passes on its final look never prompts again.
      maxRounds: (this.options.maxReportRewrites ?? DEFAULT_REPORT_REWRITES) + 1,
      exhausted: "ship",
      evaluate: async (artifacts) => {
        const findings = lint(artifacts.find((item) => item.kind === kind)?.body ?? "");
        return findings.length === 0 ? { passed: true } : { passed: false, findings: render(findings) };
      },
    };
  }

  /**
   * Runs each exit in turn against the live session.
   *
   * Findings go back as a prompt and the reply is re-parsed, so a later gate
   * judges what the earlier one left behind rather than the original answer.
   */
  private async runExitGates(
    input: ManagedPhaseInput,
    runner: PiRunner,
    gates: readonly PhaseExitGate[],
    artifacts: ManagedPhaseResult["artifacts"],
  ): Promise<{ artifacts: ManagedPhaseResult["artifacts"]; rounds: Record<string, number> }> {
    let current = artifacts;
    const rounds: Record<string, number> = {};
    for (const gate of gates) {
      for (let attempt = 1; ; attempt++) {
        rounds[gate.name] = attempt;
        const verdict = await gate.evaluate(current, attempt);
        if (verdict.passed) break;
        if (attempt >= gate.maxRounds) {
          if (gate.exhausted === "ship") break;
          throw gate.failure?.(verdict.findings) ?? new PhaseExitNotMetError(input.phase, verdict.findings);
        }
        const result = await promptWithContinueRetry(
          runner,
          verdict.findings,
          { maxContinueRetries: this.options.maxContinueRetries ?? 8 },
          this.options.promptTimeoutMs,
        );
        if (result.failure) throw new Error(result.failure.errorMessage);
        current = parseResult(input, lastAssistantText(await runner.getMessages()));
      }
    }
    return { artifacts: current, rounds };
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
      ...(options.testPathPatterns ? { testPathPatterns: options.testPathPatterns } : {}),
      ...(options.protectedPaths ? { protectedPaths: options.protectedPaths } : {}),
      ...(options.frozenTestCommit ? { frozenTestCommit: options.frozenTestCommit } : {}),
    });
  }
}

/** Check output is for a person and for the next CODE round; the failing tail
 * is where a runner puts its summary. */
function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= 2000 ? trimmed : `...\n${trimmed.slice(-2000)}`;
}
