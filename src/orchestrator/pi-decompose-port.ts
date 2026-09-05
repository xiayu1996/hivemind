import { z } from "zod";
import { POLICY_ENV_VAR, assembleGuardPolicy, serializeGuardPolicy } from "../guard/policy.js";
import { loadPromptLayers } from "../pipeline/prompt-loader.js";
import { lastAssistantText } from "../runner/assistant-text.js";
import { loadExplicitContextBundle, type ExplicitContextFile } from "../runner/context-files.js";
import type { ResolvedModel } from "../runner/model-resolver.js";
import { RpcPiRunner, type RpcRunnerConfig } from "../runner/rpc-runner.js";
import type { PiRunner } from "../runner/types.js";
import { jsonPayloadCandidates } from "../util/json-payload.js";
import type { DecomposePort, DecomposeRequest } from "./decompose-runner.js";
import type { DecompositionCandidate } from "./decompose.js";
import { humanQuestionInputSchema } from "./human-question.js";

const scenarioSchema = z.object({
  id: z.string().min(1),
  given: z.string().min(1),
  when: z.string().min(1),
  // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the scenario grammar
  then: z.string().min(1),
}).strict();

const storySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  requirement: z.string().min(1),
  scenarios: z.array(scenarioSchema),
  dependsOn: z.array(z.string()),
  predictedFootprint: z.array(z.string()),
}).strict();

const candidateSchema = z.object({
  epicId: z.string().min(1),
  businessGoal: z.string().min(1),
  stories: z.array(storySchema),
  blockingQuestion: humanQuestionInputSchema.optional(),
}).strict();

export interface PiDecomposePortOptions {
  binary: string;
  model: ResolvedModel;
  promptRoot: string;
  cwd: string;
  /**
   * Repository conventions appended to the system prompt. They are the same
   * files the Story phases load, so the shared prefix is cached across phases
   * and across cards of the same repository.
   */
  contextFiles?: ExplicitContextFile[];
  /**
   * The in-process guard. DECOMPOSE has no write tools, so the guard's job here
   * is the tool-output cap that keeps exploration from filling the context.
   */
  guard?: { extension: string; auditPath: string };
  extensions?: string[];
  createRunner?: (config: RpcRunnerConfig) => PiRunner;
}

/**
 * Runs one read-only decomposition session. It gets no write tools: producing a
 * Story list needs no change to the tree, and a DECOMPOSE that edited files
 * would be doing the work it is supposed to be planning.
 */
export class PiDecomposePort implements DecomposePort {
  constructor(private readonly options: PiDecomposePortOptions) {}

  async run(input: DecomposeRequest): Promise<DecompositionCandidate> {
    const [layers, context] = await Promise.all([
      loadPromptLayers(this.options.promptRoot, "DECOMPOSE"),
      loadExplicitContextBundle(this.options.contextFiles ?? []),
    ]);
    const guard = this.options.guard;
    const policy = guard
      ? assembleGuardPolicy({
        phase: "DECOMPOSE",
        cardId: input.epicId,
        runId: `${input.epicId}-decompose`,
        worktreePath: this.options.cwd,
        auditPath: guard.auditPath,
      })
      : undefined;
    const extensions = [...(this.options.extensions ?? []), ...(guard ? [guard.extension] : [])];
    const runner = (this.options.createRunner ?? ((config) => new RpcPiRunner(config)))({
      binary: this.options.binary,
      provider: this.options.model.provider,
      model: this.options.model,
      cwd: this.options.cwd,
      tools: ["read", "grep", "find", "ls"],
      contextFiles: "explicit",
      ...(extensions.length > 0 ? { extensions } : {}),
      ...(policy ? { env: { [POLICY_ENV_VAR]: serializeGuardPolicy(policy) } } : {}),
      systemPrompt: { mode: "replace", text: `${layers.combined}${context.text}` },
    });

    try {
      await runner.start();
      await runner.setAutoRetry(false);
      const result = await runner.prompt(promptFor(input));
      if (result.failure) throw new Error(result.failure.errorMessage);
      const raw = lastAssistantText(await runner.getMessages());
      for (const payload of jsonPayloadCandidates(raw)) {
        const parsed = candidateSchema.safeParse(payload);
        if (!parsed.success) continue;
        const { blockingQuestion, ...candidate } = parsed.data;
        return blockingQuestion === undefined ? candidate : { ...candidate, blockingQuestion };
      }
      throw new Error("DECOMPOSE returned no candidate matching the decomposition contract");
    } finally {
      await runner.stop().catch(() => undefined);
    }
  }
}

function promptFor(input: DecomposeRequest): string {
  const parts = [
    `Epic id: ${input.epicId}`,
    `Epic 标题: ${input.title}`,
    `## 需求\n\n${input.requirement.trim()}`,
  ];
  if (input.previousRejections.length > 0) {
    // Sorted so the same state produces the same prompt bytes on a rebuild.
    const rows = [...input.previousRejections].toSorted().map((reason) => `- ${reason}`);
    parts.push(`## 上一次拆解被拒的原因\n\n逐条修正，不要重复被拒的做法:\n\n${rows.join("\n")}`);
  }
  parts.push([
    "只输出一个 JSON 对象，不要附加解释。字段:",
    "epicId, businessGoal, stories[{id, title, requirement, scenarios[{id, given, when, then}], dependsOn, predictedFootprint}]",
    "信息不足时只输出 {epicId, businessGoal, stories: [], blockingQuestion}。",
    "blockingQuestion 是对象 {question, context, options[{label, recommended}]}：question 一句话；context 一句话说明它为什么决定拆解；",
    "options 给 2 到 6 个业务语言写的可选答案，最多一个 recommended: true；实在给不出选项才只写 question。",
  ].join("\n"));
  return `${parts.join("\n\n")}\n`;
}
