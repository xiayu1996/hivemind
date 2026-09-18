import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assembleGuardPolicy, POLICY_ENV_VAR, serializeGuardPolicy } from "../guard/policy.js";
import { readInterfaceContract, type PrototypePage } from "../pipeline/interface-contract.js";
import {
  describeChecklistFindings,
  flippedItems,
  stripForJudge,
  type ChecklistFinding,
} from "../pipeline/ui-checklist.js";
import { judgeUsability, type UsabilityJudgeSettings } from "../judge/usability.js";
import { mechanicalFindings } from "../verify/usability-mechanical.js";
import { loadPmPromptLayers } from "../pipeline/prompt-loader.js";
import { lastAssistantText } from "../runner/assistant-text.js";
import type { ResolvedAgentSpec } from "../runner/agent-spec.js";
import { promptWithContinueRetry } from "../runner/continue-retry.js";
import { RpcPiRunner, type RpcRunnerConfig } from "../runner/rpc-runner.js";
import type { PiRunner, PromptResult } from "../runner/types.js";
import { jsonPayloadCandidates } from "../util/json-payload.js";
import { evaluatePrototypeExit, PROTOTYPE_STATES } from "../verify/prototype-exit.js";
import {
  describeDesignLintFindings,
  execDesignLint,
  runDesignLint,
  type DesignLintRequest,
} from "../verify/design-lint.js";
import { inspectPrototypePages, type PrototypeInspectorPort } from "../verify/prototype-inspector.js";
import type { PrototypePort, PrototypeRequest, PrototypeResult } from "./prototype-runner.js";
import { requirementRunId } from "./requirement-draft.js";

/**
 * The session that draws the interface contract, and the checks it has to pass
 * before anyone reads it (design 08 section 3.2).
 *
 * It is the one product-manager phase that writes: its output is files in a
 * repository rather than a text. The guard fences those writes to the contract
 * directory, and the exit opens every page in a browser and judges what is
 * actually on it -- the two layers that will later judge the built screens,
 * applied first to the thing they will be judged against.
 *
 * Findings go back into the same session, as everywhere else: a page that is
 * missing a button is a work item for the drawing, not a verdict on the
 * requirement, and a new session would have to re-read everything this one
 * already knows.
 */

const claimSchema = z.object({
  file: z.string().trim().min(1),
  scenarios: z.array(z.string().trim().min(1)).min(1),
  visible: z.array(z.object({
    role: z.string().trim().min(1),
    text: z.string().trim().min(1),
  }).strict()).min(1),
}).strict();

const prototypeSchema = z.object({
  pages: z.array(claimSchema).min(1),
  concerns: z.array(z.string()).optional(),
}).strict();

export class PrototypeExitNotMetError extends Error {
  constructor(readonly findings: readonly string[]) {
    super(`原型出口检查没过：${findings.join("；")}`);
    this.name = "PrototypeExitNotMetError";
  }
}

export interface PiPrototypePortOptions {
  binary: string;
  spec: ResolvedAgentSpec;
  promptRoot: string;
  /** The checkout the contract is written into; also the session's cwd, so it
   * can read the repository it is drawing for. */
  worktreePath: string;
  /** Contract directory relative to the worktree, as configured. */
  contractRoot: string;
  auditPath: string;
  /** How many times the drawing may be handed its findings before the
   * requirement stops for a person. */
  maxRounds: number;
  /** Opens the drawn pages. Closed by this port when it is done with them. */
  inspector: () => Promise<PrototypeInspectorPort & { close(): Promise<void> }>;
  createRunner?: (config: RpcRunnerConfig) => PiRunner;
  extensions?: string[];
  env?: Record<string, string>;
  recordUsage?: (input: { usage: PromptResult["usage"]; spec: ResolvedAgentSpec }) => Promise<void>;
  /** The anti-pattern detector, if this host has it. It never refuses a
   * prototype -- every finding becomes a friction row, which is how the
   * question "does the anti-mean discipline change anything" gets answered
   * with data rather than with an opinion (design 08 section 3.3). */
  designLint?: {
    binary: string;
    run?: DesignLintRequest["run"];
  };
  recordFriction?: (input: { cardId: string; runId: string; kind: string; detail: string }) => Promise<void>;
  /** The judge that decides the three semantic usability items. Left out on a
   * deployment without the credential, and then the mechanical half is the
   * whole checklist -- which is the floor, not a degraded mode. */
  usability?: UsabilityJudgeSettings;
}

/** What one round of checks found, split by what each half may do about it.
 * Mechanical findings refuse like any other exit finding; semantic ones are
 * handed back while rounds remain and shipped with when they run out, because
 * a probability that never settles would otherwise burn the whole budget. */
interface ExitFindings {
  /** What each page that opened calls itself, read off the page rather than
   * taken from the model's answer: the section a person reads names screens,
   * and a file path is not a name. */
  described: readonly PrototypePage[];
  blocking: string[];
  semantic: readonly ChecklistFinding[];
  checklist: readonly ChecklistFinding[];
}

export class PiPrototypePort implements PrototypePort {
  constructor(private readonly options: PiPrototypePortOptions) {}

  async run(input: PrototypeRequest): Promise<PrototypeResult> {
    const layers = await loadPmPromptLayers(this.options.promptRoot, "PROTOTYPE");
    const runId = requirementRunId(input.requirementId);
    const policy = assembleGuardPolicy({
      phase: "PROTOTYPE",
      cardId: input.requirementId,
      runId,
      worktreePath: this.options.worktreePath,
      auditPath: this.options.auditPath,
      // The contract fence is off while the flow is being proven end to end
      // (Ryan, 2026-09-18). It is a scope rule rather than a safety one: this
      // session works in a worktree of its own, on a branch of its own, and
      // what it writes lands in a review nobody merges. Against that, its
      // first real run was spent being refused the listing of the directory it
      // had been told to fill. `prototypeFencePatterns` and its tests stay;
      // putting the fence back is this one argument.
    });
    const runner = (this.options.createRunner ?? ((config) => new RpcPiRunner(config)))({
      binary: this.options.binary,
      provider: this.options.spec.model.provider,
      model: this.options.spec.model,
      cwd: this.options.worktreePath,
      tools: [...this.options.spec.tools],
      skillDiscovery: "explicit",
      skills: [...this.options.spec.skills],
      contextFiles: "explicit",
      ...(this.options.extensions ? { extensions: this.options.extensions } : {}),
      env: { ...this.options.env, [POLICY_ENV_VAR]: serializeGuardPolicy(policy) },
      systemPrompt: { mode: "replace", text: layers.combined },
    });

    try {
      await runner.start();
      await runner.setAutoRetry(false);
      let answer = await this.ask(runner, prototypePrompt(input, this.options.contractRoot));
      let previous: readonly ChecklistFinding[] = [];
      for (let attempt = 1; ; attempt++) {
        const found: ExitFindings = answer === null
          ? { described: [], blocking: ["最后一条消息里没有按约定输出 JSON 对象"], semantic: [], checklist: [] }
          : await this.evaluate(input, answer);
        if (attempt > 1) await this.recordFlips(input, previous, found.checklist);
        previous = found.checklist;

        const soft = describeChecklistFindings(found.semantic);
        if (found.blocking.length === 0 && soft.length === 0 && answer !== null) {
          await this.recordDesignLint(input, answer.pages.map((page) => page.file));
          return { pages: answer.pages, described: found.described, concerns: answer.concerns ?? [] };
        }
        if (attempt >= this.options.maxRounds) {
          // The semantic items ship: they are a probability, and a gate that
          // can refuse forever on one would spend the budget without ever
          // being satisfied. A person reads these screens next in any case.
          if (found.blocking.length > 0) throw new PrototypeExitNotMetError(found.blocking);
          if (answer === null) throw new PrototypeExitNotMetError(["最后一条消息里没有按约定输出 JSON 对象"]);
          await this.recordShippedChecklist(input, found.semantic);
          await this.recordDesignLint(input, answer.pages.map((page) => page.file));
          return { pages: answer.pages, described: found.described, concerns: answer.concerns ?? [] };
        }
        answer = await this.ask(runner, handback([...found.blocking, ...soft]));
      }
    } finally {
      await runner.stop().catch(() => undefined);
    }
  }

  /** One turn, and the contract it has to answer in. A reply that is not the
   * contract is handed back like any other finding rather than thrown: the
   * session that wrote the files is the cheapest one to ask again. */
  private async ask(runner: PiRunner, prompt: string): Promise<z.infer<typeof prototypeSchema> | null> {
    const result = await promptWithContinueRetry(runner, prompt, { maxContinueRetries: 8 });
    if (result.failure) throw new Error(result.failure.errorMessage);
    await this.options.recordUsage?.({ usage: result.usage, spec: this.options.spec });
    const raw = lastAssistantText(await runner.getMessages());
    for (const payload of jsonPayloadCandidates(raw)) {
      const parsed = prototypeSchema.safeParse(payload);
      if (parsed.success) return parsed.data;
    }
    return null;
  }

  /** Reads the contract off disk and opens every page, then judges both. */
  private async evaluate(
    input: PrototypeRequest,
    answer: z.infer<typeof prototypeSchema>,
  ): Promise<ExitFindings> {
    const root = join(this.options.worktreePath, this.options.contractRoot);
    const read = await readInterfaceContract(root);
    const contractPages = read.kind === "present" ? read.contract.pages.map((page) => page.file) : [];
    const contractReasons = read.kind === "present"
      ? []
      : read.kind === "absent"
      ? [`${this.options.contractRoot} 下什么都没有`]
      : read.reasons;

    const inspector = await this.options.inspector();
    let evidence;
    try {
      evidence = await inspectPrototypePages({ root, pages: contractPages, port: inspector });
    } finally {
      await inspector.close().catch(() => undefined);
    }
    const exit = evaluatePrototypeExit({
      claims: answer.pages,
      evidence,
      contractPages,
      scenarios: input.scenarios.map((scenario) => scenario.id),
      tokens: read.kind === "present" ? read.contract.tokens : [],
      contractReasons,
    });

    const sources = new Map<string, string>();
    for (const file of contractPages) {
      const html = await readFile(join(root, file), "utf8").catch(() => null);
      if (html !== null) sources.set(file, html);
    }
    const mechanical = [...sources].flatMap(([file, html]) => mechanicalFindings({
      file,
      html,
      violations: evidence.find((page) => page.file === file)?.violations ?? [],
    }));
    // Asked only about pages that opened: a page with no accessibility tree is
    // already refused above, and asking about it would spend three requests to
    // learn the same thing.
    const judged = await judgeUsability(
      evidence
        .filter((page) => page.snapshot !== null && sources.has(page.file))
        .map((page) => ({
          file: page.file,
          page: stripForJudge(sources.get(page.file)!),
          snapshot: page.snapshot!,
        })),
      this.options.usability ?? { model: "", threshold: 1 },
    );

    return {
      described: read.kind === "present" ? read.contract.pages : [],
      blocking: [...exit, ...describeChecklistFindings(mechanical)],
      semantic: judged.findings,
      checklist: [...mechanical, ...judged.findings],
    };
  }

  /** Items that were a finding in exactly one of two consecutive rounds. It is
   * a friction row, not a gate: an item that flips while the page is being
   * fixed is ordinary, and one that flips round after round is the judge
   * disagreeing with itself, which is a thing to learn from data. */
  private async recordFlips(
    input: PrototypeRequest,
    previous: readonly ChecklistFinding[],
    current: readonly ChecklistFinding[],
  ): Promise<void> {
    const record = this.options.recordFriction;
    const flipped = flippedItems(previous, current);
    if (!record || flipped.length === 0) return;
    await record({
      cardId: input.requirementId,
      runId: requirementRunId(input.requirementId),
      kind: "ui_checklist_unstable",
      detail: flipped.join("、"),
    }).catch(() => undefined);
  }

  /** The semantic items that were still open when the rounds ran out. */
  private async recordShippedChecklist(
    input: PrototypeRequest,
    findings: readonly ChecklistFinding[],
  ): Promise<void> {
    const record = this.options.recordFriction;
    if (!record || findings.length === 0) return;
    for (const detail of describeChecklistFindings(findings)) {
      await record({
        cardId: input.requirementId,
        runId: requirementRunId(input.requirementId),
        kind: "ui_checklist_shipped",
        detail,
      }).catch(() => undefined);
    }
  }

  /**
   * Scans the drawn pages and files what it found as friction.
   *
   * It runs after the exit has passed rather than beside it, so a detector that
   * is slow, missing or wrong can never change whether the contract was
   * accepted. Nothing here throws: a failed scan takes its data with it and
   * nothing else.
   */
  private async recordDesignLint(input: PrototypeRequest, files: readonly string[]): Promise<void> {
    const lint = this.options.designLint;
    const record = this.options.recordFriction;
    if (!lint || !record) return;
    const runId = requirementRunId(input.requirementId);
    const outcome = await runDesignLint({
      binary: lint.binary,
      root: join(this.options.worktreePath, this.options.contractRoot),
      files: [...files].toSorted(),
      run: lint.run ?? execDesignLint,
    });
    const rows = outcome.kind === "ran"
      ? describeDesignLintFindings(outcome.findings).map((detail) => ({ kind: "design_lint_finding", detail }))
      : [{ kind: "design_lint_unavailable", detail: outcome.reason }];
    for (const row of rows) {
      await record({ cardId: input.requirementId, runId, ...row }).catch(() => undefined);
    }
  }
}

function handback(findings: readonly string[]): string {
  return [
    "出口检查在你写的契约上跑了一轮，下面这些没过：",
    findings.map((finding) => `- ${finding}`).join("\n"),
    "逐条改完，再按同样的格式输出一次 JSON。不要换方向，不要新增页面清单以外的页面。",
  ].join("\n\n") + "\n";
}

function prototypePrompt(input: PrototypeRequest, contractRoot: string): string {
  const parts = [
    `需求 id: ${input.requirementId}`,
    `需求标题: ${input.title}`,
    `目标仓库: ${input.repository}`,
    `契约目录: ${contractRoot}`,
    `## 已确认的业务目标\n\n${input.businessGoal.trim()}`,
    `## 已确认的做法\n\n${input.approach.trim()}`,
    `## 已确认的视觉方向\n\n${input.direction.summary.trim()}\n\n${
      input.direction.alternatives.length === 0
        ? "没有被否的方向。"
        : `没走的方向:\n${
          input.direction.alternatives.map((entry) => `- ${entry.option}: ${entry.reason}`).join("\n")
        }`
    }`,
    `## 页面清单（${input.interface.kind}）\n\n${
      input.interface.pages.map((page) => `- ${page.name}: ${page.purpose}`).join("\n")
    }`,
    `## 每页要承接的场景\n\n${
      input.scenarios.map((scenario) =>
        // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external PRD contract.
        `- ${scenario.id}: 给定 ${scenario.given}，当 ${scenario.when}，则 ${scenario.then}`
      ).join("\n")
    }`,
  ];
  if (input.revisionFeedback.length > 0) {
    parts.push(`## 提需求的人要求修改的地方\n\n必须逐条落进新版原型:\n\n${
      input.revisionFeedback.map((entry) => `- ${entry}`).join("\n")
    }`);
  }
  if (input.designHints.length > 0) {
    // A hint, never a gate. The detector's findings are taste, and design 08
    // section 6 forbids taste a veto: an aesthetic reviewer that may refuse
    // picks a different detail every round, so the failing set never repeats
    // and the loop only ever runs out of budget. Telling the next drawing what
    // the last one was caught doing costs nothing and is the only way these
    // travel -- without it both revisions were caught doing exactly the same
    // things, word for word.
    parts.push(`## 上一版被检出的界面问题（不否决，能改就改）\n\n${
      input.designHints.map((entry) => `- ${entry}`).join("\n")
    }`);
  }
  parts.push([
    `只能写 ${contractRoot} 目录，写别处会被拒绝。每页必须能以 ?state= 取 ${
      PROTOTYPE_STATES.join(" / ")
    } 切到四个各自完整的页面。`,
    "最后只输出一个 JSON 对象，不要附加解释。字段:",
    'pages[{file, scenarios[], visible[{role, text}]}], concerns[]',
    "file 相对契约目录写（如 pages/board.html）；visible 是这页上必须看得见的角色与文本，出口会对着可访问性树逐条核对。",
  ].join("\n"));
  return `${parts.join("\n\n")}\n`;
}
