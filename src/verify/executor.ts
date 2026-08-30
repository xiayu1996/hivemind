import { z } from "zod";
import { assembleGuardPolicy, type GuardPolicy } from "../guard/policy.js";
import { captureTreePin, evaluateTreePin, type TreePin } from "../guard/tree-pin.js";
import { validateVerdict, type TrajectoryEvidence, type VerdictDocument } from "../pipeline/verdict.js";
import type { PiRunner, RpcEvent, TokenUsage } from "../runner/types.js";
import { jsonPayloadCandidates } from "../util/json-payload.js";

const scenarioSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["passed", "failed", "inconclusive"]),
  url: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
}).strict();

const verifierReplySchema = z.object({
  scenarios: z.array(scenarioSchema),
}).strict();

export interface BlindVerifyInput {
  cardId: string;
  round: number;
  codeSessionId: string;
  worktreePath: string;
  evidencePath: string;
  auditPath: string;
  specification: string;
  declaredScenarioIds: string[];
  allowedHosts: string[];
  commitMessages: string[];
}

export interface VerifyRecord {
  cardId: string;
  round: number;
  codeSessionId: string;
  verifySessionId: string;
  verdict: "accepted" | "rejected" | "inconclusive";
  failedScenarios: string[];
  evidenceDir: string;
  createdAt: number;
}

export interface VerifyRecordStore {
  insert(record: VerifyRecord): Promise<void>;
}

export interface VerifyRunnerFactory {
  create(policy: GuardPolicy): PiRunner;
}

export interface TreePinPort {
  capture(worktreePath: string): TreePin;
  quarantine(worktreePath: string, reason: string): Promise<void>;
}

export interface BlindVerifyResult {
  record: VerifyRecord;
  screenshots: Array<{ scenarioId: string; path: string }>;
  validationErrors: string[];
  treeChanged: boolean;
  events: RpcEvent[];
  usage: TokenUsage;
  messages: unknown[];
}

function assistantText(events: readonly RpcEvent[]): string | null {
  for (const event of events.toReversed()) {
    if (event.type !== "message_end" && event.type !== "assistant_message") continue;
    const message = event.message as Record<string, unknown> | undefined;
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => {
        if (typeof part !== "object" || part === null) return false;
        const value = part as Record<string, unknown>;
        return value.type === "text" && typeof value.text === "string";
      })
      .map((part) => part.text)
      .join("");
    if (text) return text;
  }
  return null;
}

function sessionId(state: Record<string, unknown>): string {
  const value = state.sessionFile ?? state.sessionId;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("VERIFY runner did not expose a session identifier");
  }
  return value;
}

function trajectory(events: readonly RpcEvent[]): TrajectoryEvidence[] {
  const evidence: TrajectoryEvidence[] = [];
  for (const event of events) {
    if (event.type === "test_result") {
      evidence.push({
        type: event.type,
        ...(typeof event.scenarioId === "string" ? { scenarioId: event.scenarioId } : {}),
        ...(typeof event.status === "string" ? { status: event.status } : {}),
      });
      continue;
    }
    if (event.type !== "tool_execution_end" || event.isError === true) continue;
    const result = event.result as Record<string, unknown> | undefined;
    if (!Array.isArray(result?.content)) continue;
    const output = result.content
      .filter((part): part is { type: "text"; text: string } => {
        if (typeof part !== "object" || part === null) return false;
        const value = part as Record<string, unknown>;
        return value.type === "text" && typeof value.text === "string";
      })
      .map((part) => part.text)
      .join("\n");
    for (const match of output.matchAll(/\bHIVEMIND_TEST_RESULT\s+(\S+)\s+(passed|failed|inconclusive)\b/g)) {
      evidence.push({ type: "test_result", scenarioId: match[1]!, status: match[2]! });
    }
  }
  return evidence;
}

function toVerdictDocument(value: z.infer<typeof verifierReplySchema>): VerdictDocument {
  return {
    scenarios: value.scenarios.map((scenario) => ({
      id: scenario.id,
      status: scenario.status,
      ...(scenario.url === undefined ? {} : { url: scenario.url }),
      ...(scenario.screenshots === undefined ? {} : { screenshots: scenario.screenshots }),
    })),
  };
}

function promptFor(input: BlindVerifyInput): string {
  return [
    "Perform an independent blind verification of the current worktree.",
    "You have no access to the coding session. Do not modify source or repository state.",
    "Choose and run the relevant tests from the repository and the specification.",
    "After each observed test result, print: HIVEMIND_TEST_RESULT <scenario_id> <passed|failed|inconclusive>.",
    "Return only JSON: {\"scenarios\":[{\"id\":string,\"status\":\"passed\"|\"failed\"|\"inconclusive\",\"url\"?:string,\"screenshots\"?:string[]}]}",
    "Specification:",
    input.specification,
    "Declared scenarios:",
    [...input.declaredScenarioIds].toSorted().join("\n"),
  ].join("\n\n");
}

const defaultTreePin: TreePinPort = {
  capture: captureTreePin,
  async quarantine() {
    throw new Error("tree changed during VERIFY and no quarantine implementation was provided");
  },
};

/** Runs VERIFY in a fresh, blind session and persists only a code-validated verdict. */
export class BlindVerifyExecutor {
  constructor(
    private readonly runners: VerifyRunnerFactory,
    private readonly records: VerifyRecordStore,
    private readonly pins: TreePinPort = defaultTreePin,
    private readonly now: () => number = Date.now,
  ) {}

  async run(input: BlindVerifyInput): Promise<BlindVerifyResult> {
    const before = this.pins.capture(input.worktreePath);
    const startedAt = this.now();
    const policy = assembleGuardPolicy({
      phase: "VERIFY",
      cardId: input.cardId,
      runId: `${input.cardId}-verify-${input.round}`,
      worktreePath: input.worktreePath,
      evidencePath: input.evidencePath,
      auditPath: input.auditPath,
    });
    const runner = this.runners.create(policy);
    let events: RpcEvent[] = [];
    let verifySessionId = "";
    let document: VerdictDocument | null = null;
    let runnerError: string | null = null;
    let usage: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      costUsd: 0,
    };
    let messages: unknown[] = [];

    try {
      await runner.start();
      await runner.setAutoRetry(false);
      verifySessionId = sessionId(await runner.getState());
      if (verifySessionId === input.codeSessionId) {
        throw new Error("VERIFY runner reused the CODE session");
      }
      const result = await runner.prompt(promptFor(input));
      events = [...result.events];
      usage = result.usage;
      messages = await runner.getMessages();
      if (result.failure) throw new Error(result.failure.errorMessage);
      const raw = assistantText(events);
      if (!raw) throw new Error("VERIFY returned no assistant verdict");
      const candidates = jsonPayloadCandidates(raw);
      if (candidates.length === 0) throw new Error("VERIFY returned no parseable JSON verdict");
      const parsed = verifierReplySchema.safeParse(candidates[0]);
      if (!parsed.success) throw new Error("VERIFY returned a malformed verdict");
      document = toVerdictDocument(parsed.data);
    } catch (cause) {
      runnerError = cause instanceof Error ? cause.message : "VERIFY failed";
    } finally {
      await runner.stop().catch(() => undefined);
    }

    const endedAt = this.now();
    const after = this.pins.capture(input.worktreePath);
    const pin = evaluateTreePin(before, after);
    if (!pin.matches) {
      await this.pins.quarantine(input.worktreePath, "tree-pin mismatch after VERIFY");
    }

    const validation = document
      ? await validateVerdict({
          verdict: document,
          declaredScenarioIds: input.declaredScenarioIds,
          trajectory: trajectory(events),
          commitMessages: input.commitMessages,
          evidenceRoot: input.evidencePath,
          allowedHosts: input.allowedHosts,
          roundStartedAt: startedAt,
          roundEndedAt: endedAt,
        })
      : null;
    const validationErrors = [
      ...(runnerError ? [runnerError] : []),
      ...(validation?.errors ?? []),
      ...(!pin.matches ? ["tree-pin changed during VERIFY"] : []),
    ];
    const failedScenarios = document?.scenarios
      .filter((scenario) => scenario.status !== "passed")
      .map((scenario) => scenario.id)
      .toSorted() ?? [...input.declaredScenarioIds].toSorted();
    const verdict: VerifyRecord["verdict"] = !document || !validation
      ? "inconclusive"
      : validation.valid && pin.matches && failedScenarios.length === 0
        ? "accepted"
        : "rejected";
    const record: VerifyRecord = {
      cardId: input.cardId,
      round: input.round,
      codeSessionId: input.codeSessionId,
      verifySessionId: verifySessionId || `failed:${input.cardId}:${input.round}`,
      verdict,
      failedScenarios,
      evidenceDir: input.evidencePath,
      createdAt: endedAt,
    };
    await this.records.insert(record);
    const screenshots = document?.scenarios.flatMap((scenario) =>
      (scenario.screenshots ?? []).map((path) => ({ scenarioId: scenario.id, path }))) ?? [];
    return { record, screenshots, validationErrors, treeChanged: !pin.matches, events, usage, messages };
  }
}
