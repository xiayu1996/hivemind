import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import { assembleGuardPolicy, type GuardPolicy } from "../guard/policy.js";
import type { PiRunner, PromptImage, RpcEvent, TokenUsage } from "../runner/types.js";
import { promptWithContinueRetry } from "../runner/continue-retry.js";
import { jsonPayloadCandidates } from "../util/json-payload.js";
import { browserLaneInstructions } from "./executor.js";
import { writePlaywrightCliConfig } from "./browser-config.js";

/**
 * The product manager's acceptance of a delivered screen, run as its own
 * session after the functional verification has already accepted the round.
 *
 * It is deliberately not a second gate on taste. Two verdicts come back and
 * they are kept apart on purpose:
 *
 * - `acceptance` answers "is this scenario's function actually there, on the
 *   screen a user reaches" and may fail a scenario, because that is the same
 *   question the functional lane asks, asked of the interface instead of the
 *   test suite. A failure here converges: the next round either shows the
 *   button or it does not.
 * - `findings` are the look of it — spacing, alignment, wording, states,
 *   consistency with the rest of the product. They never fail a scenario and
 *   never consume an inner-loop round. Taste does not satisfy
 *   `failed(N) ⊊ failed(N-1)`: a reviewer given the power to reject on it will
 *   reject a different detail every round, which is exactly the structural
 *   failure 03 section 8 removed by collapsing the loop to one judgment. They
 *   are reported to a person, who decides whether any of them is worth a card.
 *
 * This is also why `severity` has no blocking level: there is nowhere for one
 * to go.
 */
const acceptanceSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["passed", "failed", "inconclusive"]),
  reason: z.string().optional(),
  url: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
}).strict();

const findingSchema = z.object({
  area: z.enum(["consistency", "layout", "content", "interaction"]),
  severity: z.enum(["major", "minor"]),
  note: z.string().min(1),
  scenarioId: z.string().optional(),
  screenshot: z.string().optional(),
}).strict();

const replySchema = z.object({
  acceptance: z.array(acceptanceSchema),
  findings: z.array(findingSchema),
}).strict();

export type UiAcceptance = z.infer<typeof acceptanceSchema>;
export type UiFinding = z.infer<typeof findingSchema>;

export interface UiReviewScenario {
  id: string;
  /** What a person asked for, in their words; the reviewer judges against this. */
  statement: string;
}

export interface UiReviewReference {
  /** How the reviewer refers to it, e.g. "prototype: checkout step 2". */
  label: string;
  path: string;
}

export interface UiReviewInput {
  cardId: string;
  round: number;
  storyTitle: string;
  businessGoal: string;
  /** Only the scenarios a user can see; a scenario with no interface is not reviewable here. */
  scenarios: readonly UiReviewScenario[];
  /** Screenshots the functional lane already captured, by scenario. */
  screenshots: readonly { scenarioId: string; path: string }[];
  /**
   * Prototype images from the requirement, when the requirement has any. They
   * are a reference, never the criterion: a prototype is drawn before the
   * implementation exists and is not expected to match pixel for pixel, so a
   * difference is a finding at most. Only a requirement that says in words
   * that it must match exactly makes a difference a failure.
   */
  references?: readonly UiReviewReference[];
  worktreePath: string;
  evidencePath: string;
  auditPath: string;
  allowedHosts: readonly string[];
  chromiumSandbox?: boolean;
  maxContinueRetries?: number;
  browserSession?: string;
}

export interface UiReviewResult {
  verdict: "accepted" | "rejected" | "inconclusive";
  /** Scenarios whose function the reviewer could not find on the screen. */
  failedScenarios: string[];
  acceptance: UiAcceptance[];
  findings: UiFinding[];
  validationErrors: string[];
  /** The reviewer's own failure, if it never reached a verdict. */
  runnerFailure: string | null;
  reviewSessionId: string;
  images: number;
  events: RpcEvent[];
  usage: TokenUsage;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface ScreenshotImageLimits {
  /** Turns are billed per image; a screen needs one shot, not a filmstrip. */
  maxImages: number;
  maxTotalBytes: number;
}

export const DEFAULT_SCREENSHOT_LIMITS: ScreenshotImageLimits = {
  maxImages: 12,
  maxTotalBytes: 12 * 1024 * 1024,
};

export interface LoadedScreenshots {
  images: PromptImage[];
  /** File names in the order the images were attached, so the prompt can name them. */
  names: string[];
  skipped: string[];
}

/**
 * Reads the screenshots into the shape pi's `prompt` takes.
 *
 * Order is the sorted path, so the same round attaches the same images in the
 * same order on any machine. A file that cannot be read is skipped and named
 * rather than failing the review: the reviewer is told which screen it did not
 * get, and answers `inconclusive` for it, which costs no round.
 */
export async function loadScreenshotImages(
  paths: readonly string[],
  limits: ScreenshotImageLimits = DEFAULT_SCREENSHOT_LIMITS,
): Promise<LoadedScreenshots> {
  const images: PromptImage[] = [];
  const names: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const path of [...new Set(paths)].toSorted()) {
    const mimeType = IMAGE_MIME[extname(path).toLowerCase()];
    if (!mimeType) {
      skipped.push(`${basename(path)} (not an image)`);
      continue;
    }
    if (images.length >= limits.maxImages) {
      skipped.push(`${basename(path)} (over the ${limits.maxImages}-image limit)`);
      continue;
    }
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      // The functional lane names a screenshot it believes it took; a missing
      // file is a broken run, not a rejected screen.
      skipped.push(`${basename(path)} (unreadable)`);
      continue;
    }
    if (total + content.byteLength > limits.maxTotalBytes) {
      skipped.push(`${basename(path)} (over the size budget)`);
      continue;
    }
    total += content.byteLength;
    images.push({ data: content.toString("base64"), mimeType });
    names.push(basename(path));
  }
  return { images, names, skipped };
}

export function promptFor(input: UiReviewInput, attached: LoadedScreenshots): string {
  const session = input.browserSession ?? `${input.cardId}-ui-review-${input.round}`;
  return [
    "Accept or reject this Story as the product manager who asked for it. You are looking at the delivered interface, not at the code: judge what a user sees and can do.",
    "Two answers are wanted and they are not the same question.",
    "1. Acceptance, per declared scenario: is the thing that was asked for actually there, reachable, and does it do what the statement says? Drive the browser to check anything a screenshot cannot show. `failed` means the function is missing, unreachable or wrong; `inconclusive` means you could not get to a screen that would tell you.",
    "2. Findings, on how it looks and reads: spacing and alignment, visual consistency with the rest of the product, wording, empty and error states, whether the layout holds at the size you viewed it. Findings never reject the Story — they are read by a person who decides whether any of them is worth its own card. Say what is wrong and where, not that something 'could be improved'.",
    "Do not modify source, tests, configuration or repository state.",
    ...(input.references && input.references.length > 0
      ? ["A prototype is attached for reference. It was drawn before this was built and is not expected to match pixel for pixel: a difference from it is a finding at most, and only a requirement that says in words that it must match exactly makes a difference an acceptance failure."]
      : []),
    ...(input.allowedHosts.length > 0 ? [browserLaneInstructions(session, input.allowedHosts)] : []),
    "Return only JSON: {\"acceptance\":[{\"id\":string,\"status\":\"passed\"|\"failed\"|\"inconclusive\",\"reason\"?:string,\"url\"?:string,\"screenshots\"?:string[]}],\"findings\":[{\"area\":\"consistency\"|\"layout\"|\"content\"|\"interaction\",\"severity\":\"major\"|\"minor\",\"note\":string,\"scenarioId\"?:string,\"screenshot\"?:string}]}",
    "Every declared scenario needs exactly one acceptance entry. For anything not passed, `reason` is mandatory: one sentence naming what you saw on which screen, so a person can act on that sentence alone.",
    `Story: ${input.storyTitle}`,
    `Business goal: ${input.businessGoal}`,
    "Declared scenarios:",
    input.scenarios.map((scenario) => `${scenario.id}: ${scenario.statement}`).join("\n"),
    ...(attached.names.length > 0
      ? [`Attached screenshots, in order: ${attached.names.join(", ")}`]
      : ["No screenshot was attached: judge from the browser, and answer inconclusive for anything you cannot reach."]),
    ...(attached.skipped.length > 0 ? [`Not attached: ${attached.skipped.join(", ")}`] : []),
  ].join("\n\n");
}

function parseReply(text: string | null): { reply: z.infer<typeof replySchema> | null; error: string | null } {
  if (text === null) return { reply: null, error: "the reviewer produced no message" };
  for (const candidate of jsonPayloadCandidates(text)) {
    const parsed = replySchema.safeParse(candidate);
    if (parsed.success) return { reply: parsed.data, error: null };
  }
  return { reply: null, error: "the reviewer's reply was not the requested JSON" };
}

/** Checks the reply against what was asked, before any of it is believed. */
export function validateUiReview(
  reply: z.infer<typeof replySchema>,
  declaredIds: readonly string[],
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of reply.acceptance) {
    if (seen.has(entry.id)) errors.push(`scenario ${entry.id} was accepted twice`);
    seen.add(entry.id);
    if (!declaredIds.includes(entry.id)) errors.push(`scenario ${entry.id} was not declared`);
    if (entry.status !== "passed" && !entry.reason) {
      errors.push(`scenario ${entry.id} is ${entry.status} with no reason`);
    }
  }
  for (const id of declaredIds) {
    if (!seen.has(id)) errors.push(`scenario ${id} has no acceptance entry`);
  }
  return errors;
}

export interface UiReviewRunnerFactory {
  create(policy: GuardPolicy, images: readonly PromptImage[]): PiRunner;
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
    throw new Error("UI review runner did not expose a session identifier");
  }
  return value;
}

/** Runs the product manager's acceptance of the interface in its own session. */
export class UiReviewExecutor {
  constructor(
    private readonly runners: UiReviewRunnerFactory,
    private readonly limits: ScreenshotImageLimits = DEFAULT_SCREENSHOT_LIMITS,
  ) {}

  async run(input: UiReviewInput): Promise<UiReviewResult> {
    const declaredIds = input.scenarios.map((scenario) => scenario.id);
    const attached = await loadScreenshotImages([
      ...input.screenshots.map((shot) => shot.path),
      ...(input.references ?? []).map((reference) => reference.path),
    ], this.limits);
    const policy = assembleGuardPolicy({
      phase: "VERIFY",
      cardId: input.cardId,
      runId: `${input.cardId}-ui-review-${input.round}`,
      worktreePath: input.worktreePath,
      evidencePath: input.evidencePath,
      auditPath: input.auditPath,
      e2eHostAllowlist: [...input.allowedHosts],
    });
    if (input.allowedHosts.length > 0) {
      await writePlaywrightCliConfig(input.worktreePath, {
        allowedHosts: [...input.allowedHosts],
        outputDir: input.evidencePath,
        ...(input.chromiumSandbox === undefined ? {} : { chromiumSandbox: input.chromiumSandbox }),
      });
    }
    const runner = this.runners.create(policy, attached.images);
    let events: RpcEvent[] = [];
    let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
    let reviewSessionId = "";
    let runnerFailure: string | null = null;
    let text: string | null = null;

    try {
      await runner.start();
      await runner.setAutoRetry(false);
      reviewSessionId = sessionId(await runner.getState());
      const result = await promptWithContinueRetry(
        runner,
        promptFor(input, attached),
        { maxContinueRetries: input.maxContinueRetries ?? 8 },
        undefined,
        attached.images,
      );
      events = result.events;
      usage = result.usage;
      if (result.failure) runnerFailure = result.failure.errorMessage;
      else text = assistantText(result.events);
    } finally {
      await runner.stop().catch(() => undefined);
    }

    if (runnerFailure !== null) {
      return {
        verdict: "inconclusive",
        failedScenarios: [],
        acceptance: [],
        findings: [],
        validationErrors: [],
        runnerFailure,
        reviewSessionId,
        images: attached.images.length,
        events,
        usage,
      };
    }

    const { reply, error } = parseReply(text);
    if (!reply) {
      return {
        verdict: "inconclusive",
        failedScenarios: [],
        acceptance: [],
        findings: [],
        validationErrors: [error!],
        runnerFailure: null,
        reviewSessionId,
        images: attached.images.length,
        events,
        usage,
      };
    }
    const validationErrors = validateUiReview(reply, declaredIds);
    const failedScenarios = reply.acceptance
      .filter((entry) => entry.status === "failed")
      .map((entry) => entry.id)
      .toSorted();
    // A reply that does not answer what was asked is not evidence either way,
    // so it is inconclusive rather than a rejection: 03 section 8.6 keeps a
    // review that never happened out of the convergence criterion.
    const verdict = validationErrors.length > 0
      ? "inconclusive"
      : failedScenarios.length > 0 ? "rejected" : "accepted";
    return {
      verdict,
      failedScenarios,
      acceptance: reply.acceptance,
      findings: reply.findings,
      validationErrors,
      runnerFailure: null,
      reviewSessionId,
      images: attached.images.length,
      events,
      usage,
    };
  }
}

/** What a person reads on the card: the findings, in business language. */
export function renderUiFindings(findings: readonly UiFinding[]): string {
  if (findings.length === 0) return "界面走查没有发现问题。";
  const order = { major: 0, minor: 1 } as const;
  const label = { consistency: "视觉一致性", layout: "布局", content: "文案", interaction: "交互" } as const;
  const lines = [...findings]
    .toSorted((left, right) => order[left.severity] - order[right.severity])
    .map((finding) => {
      const where = finding.scenarioId ? `${finding.scenarioId} / ` : "";
      const shot = finding.screenshot ? `（${finding.screenshot}）` : "";
      return `- [${finding.severity === "major" ? "明显" : "轻微"}] ${where}${label[finding.area]}: ${finding.note}${shot}`;
    });
  return [
    "界面走查发现以下问题。它们不影响本卡验收,也不会把卡打回开发——由你决定哪些值得单独开卡:",
    ...lines,
  ].join("\n");
}
