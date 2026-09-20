import { z } from "zod";
import type { ResolvedAgentSpec } from "../runner/agent-spec.js";
import { EVIDENCE_DIR_ENV, assembleGuardPolicy, type GuardPolicy } from "../guard/policy.js";
import { captureTreePin, describeTreePinMismatch, evaluateTreePin, type TreePin } from "../guard/tree-pin.js";
import {
  type EnvironmentJudgeSettings,
  judgeEnvironmentReasons,
} from "../judge/environment-reasons.js";
import { type ScenarioReason, splitScenarioFailures } from "../pipeline/failure-classification.js";
import { validateVerdict, type TrajectoryEvidence, type VerdictDocument } from "../pipeline/verdict.js";
import type { PiRunner, RpcEvent, TokenUsage } from "../runner/types.js";
import { promptWithContinueRetry } from "../runner/continue-retry.js";
import { addUsage } from "../runner/failure.js";
import { jsonPayloadCandidates } from "../util/json-payload.js";
import { browserLaneEnv } from "./browser-config.js";
import type { VisibleRequirement } from "./aria-snapshot.js";
import { checkStructuralLayer } from "./structural-layer.js";

export { EVIDENCE_DIR_ENV } from "../guard/policy.js";

const scenarioSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["passed", "failed", "inconclusive"]),
  reason: z.string().optional(),
  detail: z.string().optional(),
  url: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
  snapshots: z.array(z.string()).optional(),
}).strict();

const verifierReplySchema = z.object({
  scenarios: z.array(scenarioSchema),
}).strict();

export interface BlindVerifyInput {
  cardId: string;
  round: number;
  /** What this verification runs on, resolved for the verify purpose. */
  spec: ResolvedAgentSpec;
  codeSessionId: string;
  worktreePath: string;
  evidencePath: string;
  auditPath: string;
  specification: string;
  declaredScenarioIds: string[];
  /** Scenarios that must be reached in the browser, each with its own screenshot. */
  screenScenarioIds?: string[];
  /**
   * Per scenario, the roles and text SHAPE said a person would see, from the
   * frozen DoD. Scenarios absent from the map are not judged structurally,
   * which is every scenario of a Story frozen before SHAPE produced them.
   */
  visibleRequirements?: ReadonlyMap<string, readonly VisibleRequirement[]>;
  allowedHosts: string[];
  /**
   * Where the repository's application runs this round, or why it has none.
   * Undefined leaves the verifier to start whatever a page needs itself, which
   * is only right for a repository that has no application to start.
   */
  app?: AppAddress;
  /** From verify.chromiumSandbox; undefined keeps the sandbox. */
  chromiumSandbox?: boolean;
  commitMessages: string[];
  /** How many dropped streams to continue before the run is the provider's failure. */
  maxContinueRetries?: number;
  /**
   * The playwright-cli session this run drives. A session outlives one run and
   * keeps the output directory it was opened with, so two runs sharing a name
   * (a Story's VERIFY and its Epic-head re-verification) would write each
   * other's evidence; the default names the run itself.
   */
  browserSession?: string;
}

function browserSessionFor(input: BlindVerifyInput): string {
  return input.browserSession ?? `${input.cardId}-verify-${input.round}`;
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
  /** `env` carries the browser lane's own copy of the host allowlist; it is
   * empty when the round has no browser lane. It reaches the session through
   * the environment rather than a file so the verified tree stays untouched. */
  create(policy: GuardPolicy, spec: ResolvedAgentSpec, env: Record<string, string>): PiRunner;
}

export interface TreePinPort {
  capture(worktreePath: string): TreePin;
  quarantine(worktreePath: string, reason: string): Promise<void>;
}

export interface BlindVerifyResult {
  record: VerifyRecord;
  screenshots: Array<{ scenarioId: string; path: string }>;
  /** The page each scenario reported reaching. The contract layer opens these
   * again while the application is still up, so it judges the screen a person
   * would see rather than a route somebody guessed. */
  pages: Array<{ scenarioId: string; url: string }>;
  /** Why each non-passing scenario did not pass, in the verifier's words. */
  reasons: Array<{ scenarioId: string; reason: string }>;
  /** Reasons the judge said were about the box although the pattern table did
   * not match them. Carried out so a caller re-splitting the same round reuses
   * this judgement instead of paying for a second, possibly different one.
   * Absent when no judge was configured, which is the same as empty. */
  environmentalReasons?: ReadonlySet<string>;
  validationErrors: string[];
  treeChanged: boolean;
  /** The verifier's own failure, if it never reached a verdict. Telemetry must
   * record the session as unsettled rather than as a clean completion. */
  runnerFailure: string | null;
  events: RpcEvent[];
  usage: TokenUsage;
  messages: unknown[];
}

/**
 * How many times a reply that did not parse is handed back inside the same
 * session. Small on purpose: a verifier that cannot restate its own verdict
 * twice is not going to on the third ask, and the round ends inconclusive as
 * it did before.
 */
const VERDICT_HANDBACKS = 2;

/** How many times a verdict is asked to name the page structure records it
 * judged by. Two, like the malformed-verdict handback: a verifier that still
 * has not taken one is answering a question it did not look at. */
const SNAPSHOT_HANDBACKS = 2;

const VERDICT_HANDBACK_PROMPT =
  "Your last message carried no verdict this system can read. Send the verdict again as one JSON object "
  + "and nothing else: no prose around it, no code fence, every field of the contract present. "
  + "Judge nothing further and run no tools -- restate what you already decided.";

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

/**
 * The verifier's session identity, as written into `verify_records` and checked
 * against CODE's both here and by the DB.
 *
 * The header id is no longer an identity on its own: it is pinned per card and
 * lane so the provider routes a card's phases to one instance, so two runs can
 * legitimately carry the same one. The file path is the identity, and the run
 * id is mixed in when pi does not expose a path -- previously the expression
 * was `sessionFile ?? sessionId`, which left an architectural invariant hanging
 * on whether an optional field happened to be present.
 */
function sessionId(state: Record<string, unknown>, runId: string): string {
  const file = state.sessionFile;
  if (typeof file === "string" && file.length > 0) return file;
  const id = state.sessionId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("VERIFY runner did not expose a session identifier");
  }
  return `${id}#${runId}`;
}

// ANSI color codes glue word characters to the ids they decorate
// (e.g. "[22mS-VAL-01-a"), so strip them before matching anything.
// eslint-disable-next-line eslint/no-control-regex -- ESC is the literal byte being stripped
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

// Test runners state an outcome as a standalone marker: a glyph, or an
// upper-case PASS/FAIL word. Lower-case prose never qualifies.
const FAILED_MARKER = /(?:^|\s)(?:[×✗✕✘]|FAIL(?:ED)?)(?=\s|:|$)/;
const PASSED_MARKER = /(?:^|\s)(?:[✓✔]|PASS(?:ED)?)(?=\s|:|$)/;

function trajectory(events: readonly RpcEvent[]): TrajectoryEvidence[] {
  const evidence: TrajectoryEvidence[] = [];
  for (const event of events) {
    if (event.type === "test_result") {
      evidence.push({
        type: event.type,
        ...(typeof event.scenarioId === "string" ? { scenarioId: event.scenarioId } : {}),
        ...(typeof event.status === "string" ? { status: event.status } : {}),
      });
    }
  }
  for (const output of collectToolOutputs(events).map((raw) => raw.replace(ANSI_PATTERN, ""))) {
    for (const match of output.matchAll(/\bHIVEMIND_TEST_RESULT\s+(\S+)\s+(passed|failed|inconclusive)\b/g)) {
      evidence.push({ type: "test_result", scenarioId: match[1]!, status: match[2]! });
    }
    // Runner-native fallback for a verifier that ran the tests but skipped the
    // echo protocol. Only a standalone runner marker counts: prose or source
    // text that merely mentions a scenario id beside the word "passed" is not
    // evidence, or any read-only grep could mint its own green verdict.
    // Failure is read first so a test title containing "passed" cannot turn a
    // red line green.
    for (const line of output.split(/\r?\n/)) {
      const scenarioId = /\bS-[A-Z0-9]+-\d{2}-[a-z0-9]+\b/.exec(line)?.[0];
      if (!scenarioId) continue;
      if (FAILED_MARKER.test(line)) evidence.push({ type: "test_result", scenarioId, status: "failed" });
      else if (PASSED_MARKER.test(line)) evidence.push({ type: "test_result", scenarioId, status: "passed" });
    }
  }
  return evidence;
}

/** Tool output spans from both the fixture event shape and real pi RPC
 * message events, so the evidence channel works against live sessions. */
function collectToolOutputs(events: readonly RpcEvent[]): string[] {
  const outputs: string[] = [];
  for (const event of events) {
    if (event.type === "tool_execution_end") {
      if (event.isError === true) continue;
      const output = textOfContent((event.result as Record<string, unknown> | undefined)?.content);
      if (output) outputs.push(output);
      continue;
    }
    // pi streams tool output as message events (update/end) with role
    // toolResult; accept both the streaming and settled shapes.
    if (event.type !== "message" && event.type !== "message_update" && event.type !== "message_end") continue;
    const message = event.message as Record<string, unknown> | undefined;
    if (String(message?.role ?? "") !== "toolResult") continue;
    // A tool call that itself failed proves nothing; its output must not be mined.
    if (event.isError === true || message?.isError === true) continue;
    const output = textOfContent(message?.content);
    if (output) outputs.push(output);
  }
  return outputs;
}

function textOfContent(content: unknown): string {
  return Array.isArray(content)
    ? (content as Array<{ type?: string; text?: string }>)
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    : "";
}

/**
 * The verdict in a reply, or undefined when there is none to read. The last
 * well-formed payload wins: an earlier one is a draft the verifier wrote while
 * reasoning and then replaced.
 */
function readVerdict(events: readonly RpcEvent[]): z.infer<typeof verifierReplySchema> | undefined {
  const raw = assistantText(events);
  if (!raw) return undefined;
  return jsonPayloadCandidates(raw)
    .map((candidate) => verifierReplySchema.safeParse(candidate))
    .flatMap((candidate) => (candidate.success ? [candidate.data] : []))
    .at(-1);
}

/**
 * Scenarios claimed passed whose `visible` list has nothing to be checked
 * against. The structural layer (08 section 6) reads those records; with none
 * declared there is nothing to read, and the claim can only be refused.
 */
function undeclaredSnapshots(
  document: VerdictDocument,
  requirements: ReadonlyMap<string, readonly VisibleRequirement[]> | undefined,
): readonly string[] {
  if (!requirements) return [];
  return document.scenarios
    .filter((scenario) => scenario.status === "passed"
      && (requirements.get(scenario.id) ?? []).length > 0
      && (scenario.snapshots ?? []).length === 0)
    .map((scenario) => scenario.id)
    .toSorted();
}

function snapshotHandbackPrompt(scenarioIds: readonly string[]): string {
  return [
    `These scenarios are marked passed and declare \`visible\`, but name no page structure record: ${scenarioIds.join(", ")}.`,
    "A claim with nothing behind it is refused, so judge them again: open each scenario's page in the browser, call",
    "`snapshot` there, and put the file name in that scenario's `snapshots`. If the page does not show what `visible`",
    "asks for, say so and mark the scenario failed. Then send the whole verdict again as one JSON object and nothing else.",
  ].join(" ");
}

function toVerdictDocument(value: z.infer<typeof verifierReplySchema>): VerdictDocument {
  return {
    scenarios: value.scenarios.map((scenario) => ({
      id: scenario.id,
      status: scenario.status,
      ...(scenario.reason === undefined ? {} : { reason: scenario.reason }),
      ...(scenario.detail === undefined ? {} : { detail: scenario.detail }),
      ...(scenario.url === undefined ? {} : { url: scenario.url }),
      ...(scenario.screenshots === undefined ? {} : { screenshots: scenario.screenshots }),
      ...(scenario.snapshots === undefined ? {} : { snapshots: scenario.snapshots }),
    })),
  };
}

/**
 * What the verifier is told about the browser it may drive. Only the host list,
 * the card id and the application's configured address enter the text, so the
 * same round produces the same prompt on any machine; the paths the browser
 * writes to are already fixed in the worktree's Playwright configuration.
 */
export function browserLaneInstructions(
  session: string,
  allowedHosts: readonly string[],
  app?: AppAddress,
): string {
  const hosts = [...allowedHosts].toSorted().join(", ");
  return [
    "Browser lane: a headless Chromium is available through the `playwright-cli` command; always pass the session flag",
    `\`-s=${session}\`. It is already configured for this run: the browser loads only these hosts: ${hosts};`,
    "every other request is refused by the browser itself, and pages loaded from local files are not allowed.",
    "Snapshots and screenshots are saved into this round's evidence directory automatically; refer to them by file name.",
    "Only screenshots taken by playwright-cli in this session count: a file a script produced elsewhere does not exist here",
    "and the claim is refused. Report the exact URL the browser opened, never a placeholder.",
    "Call `screenshot` and `snapshot` without a filename: the default lands in the evidence directory, while a named file",
    "is written into the worktree, which changes the tree under verification and voids the round.",
    "Do not intercept or fake network responses (`route`): the page must be judged against the real service.",
    `Typical use: \`playwright-cli -s=${session} open <url>\`, then \`snapshot\`, \`click <ref>\`, \`fill <ref> <text>\`, \`screenshot\`, and \`close\`.`,
    "A scenario whose layer is ui or e2e must be exercised in the browser: report the page you judged in `url` and the",
    "screenshot file names in `screenshots`. Close the browser before returning the verdict.",
    ...applicationInstructions(app),
  ].join(" ");
}

/** Where this round's application is, or why it has none. */
export type AppAddress = { url: string } | { unavailable: string };

/**
 * How the lane reaches the application under verification.
 *
 * Without an address the verifier is told to stand one up itself, which is how
 * the same scenario on the same tree came back passed from one session and
 * inconclusive from the next: each invented its own service and judged what it
 * had invented. When the box knows the address it says so and forbids the
 * substitute; when the box has none it says that instead, and the scenarios
 * that need a screen are inconclusive for a reason that does not change
 * between rounds.
 */
function applicationInstructions(app: AppAddress | undefined): string[] {
  if (app === undefined) {
    return [
      "Other verifiers may be running on this machine: pick a port nobody is listening on (check with `lsof -i :<port>`),",
      "never assume a page on a well-known port is yours, and stop every process you started before returning the verdict.",
      "If a page needs a running service, start it yourself in the background and confirm it answers before opening pages:",
      `\`nohup <command> > "$${EVIDENCE_DIR_ENV}/service.log" 2>&1 &\` — that directory is the only place you may write,`,
      "and a process that is not detached does not outlive the command that started it.",
    ];
  }
  if ("url" in app) {
    return [
      `The application under verification is already running at ${app.url}: open its pages there.`,
      "Do not start a service of your own and do not look for the application on another port -- a page you served",
      "yourself is not the one under verification, and a verdict read off it is refused.",
    ];
  }
  return [
    `${app.unavailable}.`,
    "Do not stand up a substitute and judge that: a scenario that has to be read off a screen is inconclusive this round,",
    "and its reason says the application could not be opened. Scenarios you can settle without a page are judged as usual.",
  ];
}

function promptFor(input: BlindVerifyInput): string {
  return [
    "Perform an independent blind verification of the current worktree.",
    "You have no access to the coding session. Do not modify source or repository state.",
    "Choose and run the relevant tests from the repository and the specification.",
    "Run tests in a mode that reports each individual test name, so every scenario's outcome is observable in the transcript.",
    "Evidence protocol (mandatory): after observing the outcome of each scenario, print a line exactly of the form HIVEMIND_TEST_RESULT <scenario_id> <passed|failed|inconclusive>, once per declared scenario id. A verdict whose scenarios have no observable evidence in this session is rejected.",
    ...(input.allowedHosts.length > 0
      ? [browserLaneInstructions(browserSessionFor(input), input.allowedHosts, input.app)]
      : []),
    "Return only JSON: {\"scenarios\":[{\"id\":string,\"status\":\"passed\"|\"failed\"|\"inconclusive\",\"reason\"?:string,\"detail\"?:string,\"url\"?:string,\"screenshots\"?:string[]}]}",
    "For every scenario that is not passed, `reason` is mandatory and is written in Chinese, in the words of the person who ordered the card: one sentence saying what does not work from their side. They decide what to do next from that sentence alone, so it carries no test name, no file path and no stack frame; all of that goes in `detail`, which is written for whoever debugs it.",
    "Specification:",
    input.specification,
    "Declared scenarios:",
    [...input.declaredScenarioIds].toSorted().join("\n"),
    ...(input.screenScenarioIds && input.screenScenarioIds.length > 0
      ? [
          "Scenarios judged on a screen (open the page, look, and take a screenshot that belongs to that scenario alone; a scenario with no page and no screenshot of its own is inconclusive, never passed):",
          [...input.screenScenarioIds].toSorted().join("\n"),
        ]
      : []),
  ].join("\n\n");
}

const defaultTreePin: TreePinPort = {
  capture: captureTreePin,
  async quarantine() {
    throw new Error("tree changed during VERIFY and no quarantine implementation was provided");
  },
};

/**
 * The round's verdict.
 *
 * A tree that moved under the verifier is always a rejection: that is the
 * forgery signal, and it is about the run, not about the box. Everything that
 * did fail for environmental reasons alone is inconclusive, so the convergence
 * criterion never sees it (03 section 8.6).
 */
/** Kept absent rather than false, so a reason nobody classified stays the two
 * fields it has always been to everything that reads it. */
function scenarioReason(scenarioId: string, reason: string, environmental: boolean): ScenarioReason {
  return environmental ? { scenarioId, reason, environmental } : { scenarioId, reason };
}

function verdictOf(input: {
  hasDocument: boolean;
  valid: boolean;
  treeMatches: boolean;
  failedScenarios: readonly string[];
  codeFailures: readonly string[];
}): VerifyRecord["verdict"] {
  if (!input.hasDocument) return "inconclusive";
  if (!input.treeMatches) return "rejected";
  if (input.valid && input.failedScenarios.length === 0) return "accepted";
  if (input.failedScenarios.length === 0) return "rejected";
  return input.codeFailures.length === 0 ? "inconclusive" : "rejected";
}

/** Runs VERIFY in a fresh, blind session and persists only a code-validated verdict. */
export class BlindVerifyExecutor {
  constructor(
    private readonly runners: VerifyRunnerFactory,
    private readonly records: VerifyRecordStore,
    private readonly pins: TreePinPort = defaultTreePin,
    private readonly now: () => number = Date.now,
    /** Absent means the pattern table is the whole answer, which is what a
     * deployment without the judge credential gets. */
    private readonly environmentJudge: EnvironmentJudgeSettings | undefined = undefined,
  ) {}

  async run(input: BlindVerifyInput): Promise<BlindVerifyResult> {
    const before = this.pins.capture(input.worktreePath);
    const startedAt = this.now();
    const runId = `${input.cardId}-verify-${input.round}`;
    const policy = assembleGuardPolicy({
      phase: "VERIFY",
      cardId: input.cardId,
      runId,
      worktreePath: input.worktreePath,
      evidencePath: input.evidencePath,
      auditPath: input.auditPath,
      // The same list the verdict is validated against, applied at the tool
      // face as well: the check after the fact catches a forged claim, this
      // stops the navigation that would produce it.
      e2eHostAllowlist: input.allowedHosts,
    });
    // The browser's own copy of the same list, so a request off the allowlist
    // is refused inside the page rather than only judged afterwards.
    const browserEnv = input.allowedHosts.length > 0
      ? browserLaneEnv({
        allowedHosts: input.allowedHosts,
        outputDir: input.evidencePath,
        ...(input.chromiumSandbox === undefined ? {} : { chromiumSandbox: input.chromiumSandbox }),
      })
      : {};
    const runner = this.runners.create(policy, input.spec, browserEnv);
    let events: RpcEvent[] = [];
    let verifySessionId = "";
    let document: VerdictDocument | null = null;
    let runnerError: string | null = null;
    let providerFailure: string | null = null;
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
      verifySessionId = sessionId(await runner.getState(), runId);
      if (verifySessionId === input.codeSessionId) {
        throw new Error("VERIFY runner reused the CODE session");
      }
      // A stream the provider drops mid-run is continued in the same session,
      // the way the writing phases do; a failure that survives the retries is
      // the provider's, not the code's, and is raised rather than recorded as
      // a round the convergence criterion would then count against the card.
      let result: Awaited<ReturnType<typeof promptWithContinueRetry>>;
      try {
        result = await promptWithContinueRetry(runner, promptFor(input), { maxContinueRetries: input.maxContinueRetries ?? 8 });
      } catch (cause) {
        providerFailure = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      }
      events = [...result.events];
      usage = result.usage;
      if (result.failure) {
        providerFailure = result.failure.errorMessage;
        throw new Error(result.failure.errorMessage);
      }
      // A reply that does not parse is told so and asked again in the same
      // session, the way every other phase is. Re-running the round instead
      // showed the verifier nothing about what was wrong with the last answer,
      // so the second attempt was the first one repeated: S-R237511TD-01 was
      // parked on retry_limit_exceeded after two identical "malformed verdict"
      // rounds, having been judged on nothing. Reading the verdict costs no
      // tools and moves no files, and the tree pin below still holds.
      let parsed = readVerdict(events);
      for (let handback = 0; parsed === undefined && handback < VERDICT_HANDBACKS; handback += 1) {
        const retry = await promptWithContinueRetry(runner, VERDICT_HANDBACK_PROMPT, {
          maxContinueRetries: input.maxContinueRetries ?? 8,
        });
        events = [...events, ...retry.events];
        usage = addUsage(usage, retry.usage);
        if (retry.failure) {
          providerFailure = retry.failure.errorMessage;
          throw new Error(retry.failure.errorMessage);
        }
        parsed = readVerdict(retry.events);
      }
      if (parsed === undefined) throw new Error("VERIFY returned a malformed verdict");
      document = toVerdictDocument(parsed);
      // A scenario passed with no page structure record behind it is not a
      // judgement the code can check, and the verifier is the only session that
      // can fix it: it is the one standing in front of the page. The structural
      // layer refuses such a claim, the refusal travels to CODE, and CODE can
      // do nothing with it -- S-R237511TD-01 ran four identical rounds that way
      // and parked. So it is asked here, in the session that can still look.
      for (let handback = 0; handback < SNAPSHOT_HANDBACKS; handback += 1) {
        const undeclared = undeclaredSnapshots(document, input.visibleRequirements);
        if (undeclared.length === 0) break;
        const retry = await promptWithContinueRetry(runner, snapshotHandbackPrompt(undeclared), {
          maxContinueRetries: input.maxContinueRetries ?? 8,
        });
        events = [...events, ...retry.events];
        usage = addUsage(usage, retry.usage);
        if (retry.failure) {
          providerFailure = retry.failure.errorMessage;
          throw new Error(retry.failure.errorMessage);
        }
        const reparsed = readVerdict(retry.events);
        if (reparsed === undefined) break;
        document = toVerdictDocument(reparsed);
      }
      messages = await runner.getMessages();
    } catch (cause) {
      runnerError = cause instanceof Error ? cause.message : "VERIFY failed";
    } finally {
      await runner.stop().catch(() => undefined);
    }
    if (providerFailure !== null) throw new Error(`VERIFY provider failure: ${providerFailure}`);

    const endedAt = this.now();
    const after = this.pins.capture(input.worktreePath);
    const pin = evaluateTreePin(before, after);
    if (!pin.matches) {
      await this.pins.quarantine(input.worktreePath, `tree-pin mismatch after VERIFY: ${describeTreePinMismatch(before, after)}`);
    }

    const observed = trajectory(events);
    const validation = document
      ? await validateVerdict({
          verdict: document,
          declaredScenarioIds: input.declaredScenarioIds,
          ...(input.screenScenarioIds ? { screenScenarioIds: input.screenScenarioIds } : {}),
          ...(input.app && "url" in input.app ? { appUrl: input.app.url } : {}),
          trajectory: observed,
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
    const declared = new Set(input.declaredScenarioIds);
    // The convergence criterion must run on observed failures, not on what the
    // verifier said about itself: a scenario the trajectory shows failing is
    // failed even when the verdict claims otherwise.
    const observedFailures = observed
      .filter((event) => event.status === "failed" && event.scenarioId !== undefined && declared.has(event.scenarioId))
      .map((event) => event.scenarioId!);
    // A claim the code checks refused (a screenshot that does not exist, a host
    // off the list) is a failed scenario, not a footnote: the convergence
    // criterion and the next CODE round both work from the failed set.
    const refusedClaims = (validation?.errors ?? [])
      .map((error) => error.slice(0, error.indexOf(": ")))
      .filter((id) => declared.has(id));
    // The structural layer (08 section 6): the page either carried the roles
    // and text the scenario declared, or it did not. Read from the snapshots
    // the round left behind, by code, because the round is what is on trial.
    const structural = input.visibleRequirements
      ? await checkStructuralLayer({
          root: input.evidencePath,
          subjects: (document?.scenarios ?? [])
            .filter((scenario) => scenario.status === "passed" && input.visibleRequirements!.has(scenario.id))
            .map((scenario) => ({
              id: scenario.id,
              snapshots: scenario.snapshots ?? [],
              required: input.visibleRequirements!.get(scenario.id) ?? [],
            })),
        })
      : [];
    const failedScenarios = [...new Set([
      ...(document?.scenarios.filter((scenario) => scenario.status !== "passed").map((scenario) => scenario.id)
        ?? [...declared]),
      ...observedFailures,
      ...refusedClaims,
      ...structural.map((finding) => finding.id),
    ])].toSorted();
    const scenarioReasons = [
      // `inconclusive` is the verifier saying it could not tell, and it is
      // carried here rather than recovered from the sentence afterwards. The
      // schema offers the status, the prompt teaches it, and the UI review
      // lane has always honoured it; only this lane folded it into `failed`
      // and then asked a pattern table written in English to recognise a
      // reason the same prompt requires to be written in Chinese. What got
      // through was whatever the judge happened to score above the threshold:
      // S-R237511OV-02 round 3 answered `inconclusive` for all four screen
      // scenarios with `net::ERR_CONNECTION_REFUSED` in their detail, three
      // moved at 0.74-0.84 and the fourth did not, so the round counted
      // against the code and the card was parked two rounds later.
      //
      // A claim of `inconclusive` cannot hide a failure. The trajectory is the
      // box's own record, so a scenario it shows failing is failed whatever
      // the verdict says about it -- the status is taken at its word only for
      // a scenario nothing else contradicts. A refused claim or a structural
      // finding adds its own reason for the same scenario, and a scenario is
      // environmental only if every reason for it is. A lane that answers
      // nothing but `inconclusive` is bounded by the consecutive-inconclusive
      // limit, which stops the card saying exactly that.
      ...document?.scenarios
        .filter((scenario) => scenario.status !== "passed" && scenario.reason)
        .map((scenario) =>
          scenarioReason(
            scenario.id,
            scenario.reason!,
            scenario.status === "inconclusive" && !observedFailures.includes(scenario.id),
          )) ?? [],
      ...structural.map((finding) =>
        scenarioReason(finding.id, finding.reason, finding.evidenceMissing === true)),
      // A scenario the trajectory failed while the verdict called it passed has
      // no reason of the verifier's own: the verifier did not think it had
      // failed. The box knows why it is failed anyway and says so, because a
      // failure carried forward without a reason reaches a person as a blank
      // and reaches the regression lane as one break indistinguishable from
      // every other reasonless one.
      ...observedFailures
        .filter((id) => !(document?.scenarios ?? []).some((scenario) => scenario.id === id && scenario.status !== "passed"))
        .map((id) => ({ scenarioId: id, reason: "这条场景在运行记录里判为未通过，但结论里写成通过" })),
    ];
    const missingEvidence = new Set(validation?.missingEvidence ?? []);
    const environmentReasons = [
      ...scenarioReasons,
      // The check that wrote one of these looked for a file and did not find
      // it, so there is nothing to recognise and nothing to be confident about.
      ...(validation?.errors ?? []).map((error) =>
        scenarioReason(error.slice(0, error.indexOf(": ")), error, missingEvidence.has(error))),
    ];
    // A round the box lost says nothing about the code, and the convergence
    // criterion only means something on code-level failures (03 section 8.6).
    // The pattern table decides first and the judge is asked only about what it
    // did not recognise, so this can add environment failures and never remove
    // one.
    const judged = await judgeEnvironmentReasons(
      this.environmentJudge?.judge,
      environmentReasons.map((entry) => entry.reason),
      { model: this.environmentJudge?.model ?? "", threshold: this.environmentJudge?.threshold ?? 1 },
    );
    await this.environmentJudge?.onJudged?.(judged);
    const split = splitScenarioFailures(failedScenarios, environmentReasons, judged.environmental);
    const verdict: VerifyRecord["verdict"] = verdictOf({
      hasDocument: Boolean(document && validation),
      valid: validation?.valid ?? false,
      treeMatches: pin.matches,
      failedScenarios,
      codeFailures: split.code,
    });
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
    const pages = document?.scenarios.flatMap((scenario) =>
      scenario.url ? [{ scenarioId: scenario.id, url: scenario.url }] : []) ?? [];
    return { record, screenshots, pages, reasons: scenarioReasons, environmentalReasons: judged.environmental, validationErrors, treeChanged: !pin.matches, runnerFailure: runnerError, events, usage, messages };
  }
}
