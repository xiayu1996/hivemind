import { mkdir, readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  POLICY_ENV_VAR,
  assembleGuardPolicy,
  serializeGuardPolicy,
} from "../guard/policy.js";
import { verifyCompletion, type CompletionJudge } from "../pipeline/completion-verifier.js";
import { CANONICAL_CAPTURE_ENV } from "../observability/capture-contract.js";
import { loadPromptLayers } from "../pipeline/prompt-loader.js";
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
  completionJudge: CompletionJudge;
  contextFiles?: ExplicitContextFile[];
  extensions?: string[];
  env?: Record<string, string>;
  maxContinueRetries?: number;
  createRunner?: (config: RpcRunnerConfig) => PiRunner;
  recordTelemetry?: (input: PhaseTelemetryInput) => Promise<void>;
  readProviderPayloads?: (path: string) => Promise<unknown[]>;
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

function flattenToString(item: unknown): string {
  if (typeof item === "string") return item;
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    return Object.entries(item).map(([key, value]) => `${key}: ${String(value)}`).join("; ");
  }
  return stringify(item);
}

/** Compacts observable tool activity out of the session so the completion
 * judge can check artifact claims against what actually ran on the host.
 * Head and tail are kept per result because pass/fail summaries sit at the
 * end of long command output. */
function toolEvidenceDigest(messages: unknown[]): string[] {
  const results: string[] = [];
  for (const message of messages) {
    const record = message as { role?: string; content?: unknown };
    if (record.role !== "toolResult") continue;
    const text = Array.isArray(record.content)
      ? (record.content as Array<{ type?: string; text?: string }>)
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n")
      : "";
    const trimmed = text.trim();
    if (!trimmed) continue;
    results.push(trimmed.length <= 500
      ? trimmed
      : `${trimmed.slice(0, 250)}\n...\n${trimmed.slice(-250)}`);
  }
  return results.slice(-20);
}

/** What each phase owes, so the completion judge does not import its own
 * assumptions from the phase name. */
const PHASE_CONTRACTS: Record<ManagedPhaseInput["phase"], string> = {
  DESIGN: "Read-only analysis: produce the design summary and the frozen DoD as JSON. No code changes.",
  CODE: "Implement the DoD scenarios in the worktree with tests, run the relevant verification, and report the implementation JSON.",
  REGRESSION_FIX: "Fix the regressed scenarios in the worktree and report the implementation JSON.",
  MERGE: "Prepare the delivery report JSON only. Publishing the branch and opening the MR are performed by the orchestrator outside this session; the agent must not merge, push or deploy.",
};

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
    });
    const runner = this.createRunner({
      binary: this.options.binary,
      provider: this.options.model.provider,
      model: this.options.model.id,
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
      const result = await promptWithContinueRetry(runner, input.prompt, {
        maxContinueRetries: this.options.maxContinueRetries ?? 8,
      });
      if (result.failure) throw new Error(result.failure.errorMessage);
      const messages = await runner.getMessages();
      const providerPayloads = await (this.options.readProviderPayloads ?? readProviderPayloads)(capturePath);
      if (providerPayloads.length === 0) throw new Error("phase provider request was not captured");
      const raw = lastAssistantText(messages);
      const artifacts = parseResult(input, raw);
      const completion = await verifyCompletion(this.options.completionJudge, {
        phase: input.phase,
        contract: PHASE_CONTRACTS[input.phase],
        claimedArtifact: raw,
        sideEffects: {
          settled: result.settled,
          sessionId: phaseSessionId,
          eventCount: result.events.length,
          usage: result.usage,
          toolResults: toolEvidenceDigest(messages),
        },
      });
      if (!completion.done) throw new Error(completion.reason);
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
}
