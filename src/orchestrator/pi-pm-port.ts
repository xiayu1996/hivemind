import { z } from "zod";
import { loadPmPromptLayers, type PmPhase } from "../pipeline/prompt-loader.js";
import { lastAssistantText } from "../runner/assistant-text.js";
import type { ResolvedAgentSpec } from "../runner/agent-spec.js";
import { RpcPiRunner, type RpcRunnerConfig } from "../runner/rpc-runner.js";
import type { PiRunner, PromptResult } from "../runner/types.js";
import { jsonPayloadCandidates } from "../util/json-payload.js";
import type { ClarifyPort, ClarifyRequest, ClarifyRound } from "./clarify-loop.js";
import { humanQuestionInputSchema, questionLines } from "./human-question.js";
import type { PrdPort, PrdRequest } from "./prd-runner.js";
import type { SolutionPort, SolutionRequest } from "./solution-runner.js";
import type { SolutionBody, SolutionCandidate } from "./requirement-solution.js";
import type { RequirementDecomposePort, RequirementDecomposeRequest } from "./requirement-decompose.js";
import type {
  ClarificationCandidate,
  PrdCandidate,
  RequirementDecompositionCandidate,
} from "./requirement-artifacts.js";

const clarificationSchema = z.object({
  status: z.enum(["ask", "ready"]),
  questions: z.array(humanQuestionInputSchema).optional(),
  summary: z.string().optional(),
}).strict();

const prdSchema = z.object({
  businessGoal: z.string().min(1),
  nonGoals: z.array(z.string()).optional(),
  scenarios: z.array(z.object({
    id: z.string().min(1),
    given: z.string().min(1),
    when: z.string().min(1),
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external PRD contract.
    then: z.string().min(1),
  }).strict()),
  openQuestions: z.array(z.string()).optional(),
}).strict();

const solutionSchema = z.object({
  approach: z.object({
    summary: z.string(),
    alternatives: z.array(z.object({ option: z.string(), reason: z.string() }).strict()).optional(),
  }).strict(),
  stackChanges: z.array(z.object({
    kind: z.enum(["added", "upgraded", "removed"]),
    name: z.string(),
    reason: z.string(),
    impact: z.string(),
  }).strict()).optional(),
  openDecisions: z.array(z.object({ question: z.string(), recommendation: z.string() }).strict()).optional(),
  qualityGates: z.array(z.object({
    name: z.string(),
    command: z.array(z.string()),
    covers: z.string(),
  }).strict()).optional(),
  interface: z.object({
    kind: z.enum(["web", "mobile", "desktop"]),
    pages: z.array(z.object({ name: z.string(), purpose: z.string() }).strict()),
  }).strict().nullable().optional(),
}).strict();

const decompositionSchema = z.object({
  epics: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    businessGoal: z.string().min(1),
    body: z.string().min(1),
    scenarioIds: z.array(z.string()),
  }).strict()),
}).strict();

export interface PiPmPortOptions {
  binary: string;
  /** Model, tools, skills and limits for this call site, from the one resolver.
   * Taking a bare model here is what let the tool surface be written out again
   * beside every spawn, each copy free to drift from the others. */
  spec: ResolvedAgentSpec;
  promptRoot: string;
  cwd: string;
  extensions?: string[];
  /** Extra variables for the pi spawn; an API-key provider needs its key here. */
  env?: Record<string, string>;
  createRunner?: (config: RpcRunnerConfig) => PiRunner;
  /** What one session cost, reported per session. The requirement lane spends
   * real money and used to record none of it, so a card's total was the
   * execution half of a bill nobody could see the other half of. */
  recordUsage?: (input: SessionUsage) => Promise<void>;
}

/** One product-manager session's bill, attributed to what it ran on. */
export interface SessionUsage {
  phase: PmPhase;
  usage: PromptResult["usage"];
  spec: ResolvedAgentSpec;
}

/**
 * Runs the product manager's read-only sessions. It gets no write tools at all:
 * its whole output is text a person will read and approve, and a product
 * manager that edited the tree would be doing the work it is supposed to be
 * describing.
 */
export class PiPmPort implements ClarifyPort, PrdPort, SolutionPort, RequirementDecomposePort {
  constructor(private readonly options: PiPmPortOptions) {}

  async run(input: ClarifyRequest): Promise<ClarificationCandidate>;
  async run(input: PrdRequest): Promise<PrdCandidate>;
  async run(input: SolutionRequest): Promise<SolutionCandidate>;
  async run(input: RequirementDecomposeRequest): Promise<RequirementDecompositionCandidate>;
  async run(
    input: ClarifyRequest | PrdRequest | SolutionRequest | RequirementDecomposeRequest,
  ): Promise<unknown> {
    if ("maxQuestions" in input) return this.session("CLARIFY", clarifyPrompt(input), clarificationSchema);
    // The solution is the only request that names a repository: what it may
    // keep or change is that repository's stack.
    if ("repository" in input) return this.session("SOLUTION", solutionPrompt(input), solutionSchema);
    if ("revisionFeedback" in input) return this.session("PRD", prdPrompt(input), prdSchema);
    return this.session("REQUIREMENT_DECOMPOSE", decomposePrompt(input), decompositionSchema);
  }

  private async session<T>(phase: PmPhase, prompt: string, schema: z.ZodType<T>): Promise<T> {
    const layers = await loadPmPromptLayers(this.options.promptRoot, phase);
    const runner = (this.options.createRunner ?? ((config) => new RpcPiRunner(config)))({
      binary: this.options.binary,
      provider: this.options.spec.model.provider,
      model: this.options.spec.model,
      cwd: this.options.cwd,
      tools: [...this.options.spec.tools],
      skillDiscovery: "explicit",
      skills: [...this.options.spec.skills],
      contextFiles: "explicit",
      ...(this.options.extensions ? { extensions: this.options.extensions } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      systemPrompt: { mode: "replace", text: layers.combined },
    });

    try {
      await runner.start();
      await runner.setAutoRetry(false);
      const result = await runner.prompt(prompt);
      if (result.failure) throw new Error(result.failure.errorMessage);
      // Reported before the contract is checked: the tokens were spent whether
      // or not the answer turns out to be usable.
      await this.options.recordUsage?.({ phase, usage: result.usage, spec: this.options.spec });
      const raw = lastAssistantText(await runner.getMessages());
      for (const payload of jsonPayloadCandidates(raw)) {
        const parsed = schema.safeParse(payload);
        if (parsed.success) return parsed.data;
      }
      throw new Error(`${phase} returned nothing matching the product manager contract`);
    } finally {
      await runner.stop().catch(() => undefined);
    }
  }
}

function conversation(history: readonly ClarifyRound[]): string {
  if (history.length === 0) return "## 已有问答\n\n还没有问过任何问题。";
  const lines: string[] = ["## 已有问答"];
  for (const round of history) {
    lines.push(`\n第 ${round.round} 轮:`);
    for (const [index, question] of round.questions.entries()) {
      const [first, ...rest] = questionLines(question);
      lines.push(`- 问 ${index + 1}: ${first}`, ...rest.map((line) => `  ${line}`));
    }
    if (round.answers === null) {
      lines.push("- 这一轮还没有收到回答");
      continue;
    }
    for (const [index, answer] of round.answers.entries()) lines.push(`- 答 ${index + 1}: ${answer}`);
  }
  return lines.join("\n");
}

function rejections(reasons: readonly string[]): string[] {
  if (reasons.length === 0) return [];
  // Sorted so the same state produces the same prompt bytes on a rebuild.
  const rows = [...reasons].toSorted().map((reason) => `- ${reason}`);
  return [`## 上一次产出被拒的原因\n\n逐条修正，不要重复被拒的做法:\n\n${rows.join("\n")}`];
}

function clarifyPrompt(input: ClarifyRequest): string {
  return [
    `需求 id: ${input.requirementId}`,
    `需求标题: ${input.title}`,
    `## 原始需求\n\n${input.originalRequest.trim()}`,
    conversation(input.history),
    ...rejections(input.previousRejections),
    [
      `一批最多 ${input.maxQuestions} 个问题。只输出一个 JSON 对象，不要附加解释:`,
      `{"status":"ask","questions":[{"question":"…","context":"…","options":[{"label":"…","recommended":true},{"label":"…"}]}]}`,
      `或 {"status":"ready","summary":"…"}`,
      "每个问题给 2 到 6 个业务语言写的可选答案，最多一个 recommended: true；context 一句话说明这个问题为什么影响产出；实在给不出选项时该问题只写 question。",
    ].join("\n"),
  ].join("\n\n") + "\n";
}

function prdPrompt(input: PrdRequest): string {
  const parts = [
    `需求 id: ${input.requirementId}`,
    `需求标题: ${input.title}`,
    `## 原始需求\n\n${input.originalRequest.trim()}`,
    conversation(input.history),
  ];
  if (input.revisionFeedback.length > 0) {
    const rows = input.revisionFeedback.map((entry) => `- ${entry}`);
    parts.push(`## 提需求的人要求修改的地方\n\n必须逐条落进新版 PRD:\n\n${rows.join("\n")}`);
  }
  parts.push(...rejections(input.previousRejections));
  parts.push([
    "只输出一个 JSON 对象，不要附加解释。字段:",
    "businessGoal, nonGoals[], scenarios[{id, given, when, then}], openQuestions[]",
    `场景 id 以 ${input.requirementId}- 开头。`,
  ].join("\n"));
  return `${parts.join("\n\n")}\n`;
}

function scenarioLines(scenarios: readonly { id: string; given: string; when: string; then: string }[]): string[] {
  // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external PRD contract.
  return scenarios.map((scenario) => `- ${scenario.id}: 给定 ${scenario.given}，当 ${scenario.when}，则 ${scenario.then}`);
}

function solutionPrompt(input: SolutionRequest): string {
  const parts = [
    `需求 id: ${input.requirementId}`,
    `需求标题: ${input.title}`,
    `目标仓库: ${input.repository}`,
    `## 已确认的业务目标\n\n${input.businessGoal.trim()}`,
    ...(input.nonGoals.length > 0
      ? [`## 本次明确不做\n\n${input.nonGoals.map((entry) => `- ${entry}`).join("\n")}`]
      : []),
    `## 要支撑的场景\n\n${scenarioLines(input.scenarios).join("\n")}`,
  ];
  if (input.revisionFeedback.length > 0) {
    const rows = input.revisionFeedback.map((entry) => `- ${entry}`);
    parts.push(`## 提需求的人要求修改的地方\n\n必须逐条落进新版方案:\n\n${rows.join("\n")}`);
  }
  parts.push(...rejections(input.previousRejections));
  parts.push([
    "只输出一个 JSON 对象，不要附加解释。字段:",
    "approach{summary, alternatives[{option, reason}]}, stackChanges[{kind, name, reason, impact}],",
    "openDecisions[{question, recommendation}], qualityGates[{name, command[], covers}], interface",
    "不涉及界面时 interface 写 null；沿用现有技术栈时 stackChanges 写空数组。",
  ].join("\n"));
  return `${parts.join("\n\n")}\n`;
}

/**
 * What the approved solution binds the split to. Rendered from the stored body
 * in a fixed order so the same state produces the same prompt bytes.
 */
function solutionSection(solution: SolutionBody | null): string[] {
  if (!solution) return [];
  const lines = [`做法: ${solution.approach.summary}`];
  for (const change of solution.stackChanges) {
    lines.push(`技术栈变动: ${change.kind} ${change.name} — ${change.reason}`);
  }
  if (solution.interface) {
    lines.push(`界面: ${solution.interface.kind}，共 ${solution.interface.pages.length} 个页面`);
    for (const page of solution.interface.pages) lines.push(`- ${page.name}: ${page.purpose}`);
    lines.push("这条需求有界面，按页面与流程切 Epic，不要按功能名词切。");
  }
  return [`## 已确认的技术方案\n\n${lines.join("\n")}`];
}

function decomposePrompt(input: RequirementDecomposeRequest): string {
  const scenarios = scenarioLines(input.scenarios);
  const parts = [
    `需求 id: ${input.requirementId}`,
    `需求标题: ${input.title}`,
    `## 已确认的业务目标\n\n${input.businessGoal.trim()}`,
    ...(input.nonGoals.length > 0
      ? [`## 本次明确不做\n\n${input.nonGoals.map((entry) => `- ${entry}`).join("\n")}`]
      : []),
    ...solutionSection(input.solution),
    `## 必须全部覆盖的场景\n\n${scenarios.join("\n")}`,
    ...rejections(input.previousRejections),
    [
      "只输出一个 JSON 对象，不要附加解释。字段:",
      "epics[{id, title, businessGoal, body, scenarioIds}]",
      "id 用大写字母与数字，2 到 16 位；每条场景必须且只能出现在一个 Epic 的 scenarioIds 里。",
    ].join("\n"),
  ];
  return `${parts.join("\n\n")}\n`;
}
