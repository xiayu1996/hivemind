import { z } from "zod";
import { assembleSystemPrompt, type PromptLayer } from "../agents/prompt.ts";
import type { RecipeStep } from "../domain/recipe.ts";
import { enforceFence, PRODUCT_FILES } from "../gates/fence.ts";
import type { InputRow, QuestionRow, RequirementRow, Waiting } from "../store/store.ts";
import { repositoryOf, runSession, sessionLimits, worktreeOf, type LoopContext } from "./context.ts";
import { render } from "./messages.ts";
import type { StepOutcome } from "./outcome.ts";
import { checkWrites, PRODUCT_DIR, productDocuments, readProduct, readText } from "./product.ts";
import { renderContract } from "./render.ts";
import { commitProductFiles, unavailable } from "./shared.ts";

/**
 * An author step: the planner writes product files (the product and its
 * acceptance contract, the architecture and how to check it, the plan) from
 * the requirement, everything written so far and whatever a person said about
 * the last version. The files are validated before the step counts as done,
 * and a step that a person must approve waits for that approval of exactly
 * the commit it produced.
 */

export const authorResultSchema = z
  .object({
    /** For the person approving: what was decided, in their language. */
    summary: z.string().min(1),
    decisions: z
      .array(
        z
          .object({
            decision: z.string().min(1),
            reason: z.string().min(1),
            alternatives: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
    /** Only what blocks the step: the answer would change what gets built and cannot be found out. */
    questions: z.array(z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).default([]) }).strict()).default([]),
  })
  .strict();

export type AuthorResult = z.infer<typeof authorResultSchema>;

const PLANNER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export async function authorStep(context: LoopContext, requirement: RequirementRow, step: RecipeStep): Promise<StepOutcome> {
  const worktree = worktreeOf(context, requirement);
  const base = await context.git.head(worktree);
  const feedback = (await context.store.unconsumedInputs(requirement.id)).filter((input) => input.kind === "comment");
  const answered = await context.store.answeredQuestions(requirement.id);
  const previousFindings = parseFindings(requirement.stepFindings);

  const layers: PromptLayer[] = [
    await context.prompts.layer("base"),
    await context.prompts.layer("roles/planner"),
    await context.prompts.layer(`steps/${step.prompt ?? step.id}`),
  ];
  if (step.research) layers.push(await context.prompts.layer("steps/research"));
  layers.push(requirementLayer(requirement));

  const run = await runSession(context, {
    requirementId: requirement.id,
    itemId: null,
    step: step.id,
    session: {
      role: "planner",
      cwd: worktree,
      candidates: context.config.models.roles.planner,
      systemPrompt: assembleSystemPrompt(layers, await productDocuments(worktree)),
      builtinTools: PLANNER_TOOLS,
      tools: [],
      policy: { allowedTools: [...PLANNER_TOOLS, "submit_result"], root: worktree, writable: [PRODUCT_FILES], fenced: [] },
      env: context.config.childEnv(),
      ...sessionLimits(context, "planner"),
    },
    task: authorTask(step, feedback, answered, previousFindings),
    result: { schema: authorResultSchema, description: "Submit once every file this step writes is complete and valid." },
    check: () => checkWrites(worktree, step.writes),
    maxHandbacks: context.config.limits.maxHandbacks,
  });

  const restored = await enforceFence(context.git, worktree, base, "planner");
  if (restored.length > 0) context.log("fence.restored", { requirement: requirement.id, step: step.id, paths: restored });

  if (!run.ok) {
    if (run.reason === "unavailable" || run.needsHuman) return unavailable(context, run);
    await context.git.reset(worktree, base, "hard");
    const findings = run.findings.length > 0 ? run.findings : [run.detail];
    const sessions = await context.store.recordStepFailure(requirement.id, findings);
    if (sessions < context.config.limits.maxAuthorSessions) return { kind: "again" };
    const questionId = `${requirement.id}-${step.id}-stuck-${sessions}`;
    const body = render(context.messages.questions.authorStuck, { step: step.id, sessions, findings: findings.map((line) => `- ${line}`).join("\n") });
    await context.store.addQuestion(requirement.id, { id: questionId, body, options: [] });
    await context.board.ask(requirement.boardRef, { id: questionId, body, options: [] });
    return { kind: "wait", waiting: { kind: "answer", questionId }, note: context.messages.status.waitingAnswer };
  }

  const revision = await commitProductFiles(context, worktree, `${PRODUCT_DIR}: ${step.id}`);
  await context.store.setTrunk(requirement.id, revision);
  await context.store.consumeInputs(feedback.map((input) => input.sourceId));
  await context.store.clearStepFailures(requirement.id);

  const result = run.value;
  if (result.questions.length > 0) {
    const questionId = `${requirement.id}-${step.id}-${revision.slice(0, 7)}`;
    const body = result.questions.map((entry, index) => `${index + 1}. ${entry.question}${entry.options.length > 0 ? `\n   ${entry.options.join(" / ")}` : ""}`).join("\n");
    await context.store.addQuestion(requirement.id, { id: questionId, body, options: result.questions.flatMap((entry) => entry.options) });
    await context.board.ask(requirement.boardRef, { id: questionId, body, options: [] });
    return { kind: "wait", waiting: { kind: "answer", questionId }, note: context.messages.status.waitingAnswer };
  }

  if (step.approval === "never" || step.gate === undefined) return { kind: "next" };
  const since = (await context.store.lastApprovedRevision(requirement.id)) ?? `refs/remotes/origin/${repositoryOf(context, requirement).defaultBranch}`;
  const documents = await approvalDocuments(context, worktree, since);
  if (step.approval === "on_change" && documents.length === 0) return { kind: "next" };
  return requestApproval(context, requirement, { kind: "approval", gate: step.gate, revision, onApproval: "next_step" }, result, documents);
}

export async function requestApproval(
  context: LoopContext,
  requirement: RequirementRow,
  waiting: Extract<Waiting, { kind: "approval" }>,
  result: Pick<AuthorResult, "summary" | "decisions">,
  documents: readonly { name: string; content: string }[],
): Promise<StepOutcome> {
  const { gate, revision } = waiting;
  // A person who already approved exactly this revision at this gate has nothing new to look at.
  if ((await context.store.approvalDecision(requirement.id, gate, revision)) === "approved") {
    return waiting.onApproval === "next_step" ? { kind: "next" } : { kind: "again" };
  }
  const gateName = context.messages.gates[gate];
  const decisions = result.decisions
    .map((entry) => `- ${entry.decision}: ${entry.reason}${entry.alternatives.length > 0 ? ` (${entry.alternatives.join(", ")})` : ""}`)
    .join("\n");
  await context.store.requestApproval(requirement.id, gate, revision);
  await context.board.requestApproval(requirement.boardRef, {
    gate,
    revision,
    title: render(context.messages.approval.title, { gate: gateName, title: requirement.title }),
    summary: render(context.messages.approval.body, { summary: result.summary, decisions }),
    documents,
  });
  return { kind: "wait", waiting, note: render(context.messages.status.waitingApproval, { gate: gateName }) };
}

/**
 * What a person reads to approve: every product file changed since the
 * revision they last approved, so steps that need no approval of their own
 * (the interface design before the architecture) are seen at the next gate.
 * The contract is shown as sentences rather than YAML; pages and other files
 * are listed for the person to open.
 */
async function approvalDocuments(context: LoopContext, worktree: string, since: string): Promise<{ name: string; content: string }[]> {
  const product = await readProduct(worktree);
  const changed = (await context.git.changedPaths(worktree, since))
    .filter((path) => path.startsWith(`${PRODUCT_DIR}/`))
    .map((path) => path.slice(PRODUCT_DIR.length + 1))
    .filter((file) => !file.startsWith("scratch/") && !file.startsWith("acceptance/"))
    .toSorted();
  const documents: { name: string; content: string }[] = [];
  const listed: string[] = [];
  for (const file of changed) {
    if (file === "acceptance.yaml" && product.contract !== null) {
      documents.push({ name: file, content: renderContract(product.contract) });
      continue;
    }
    if (!/\.(md|ya?ml)$/.test(file)) {
      listed.push(file);
      continue;
    }
    const text = await readText(worktree, file);
    if (text !== null) documents.push({ name: file, content: text });
  }
  if (listed.length > 0) documents.push({ name: "files", content: listed.map((file) => `- ${PRODUCT_DIR}/${file}`).join("\n") });
  return documents;
}

function requirementLayer(requirement: RequirementRow): PromptLayer {
  return { name: "requirement", text: `# The requirement, as the person wrote it\n\n## ${requirement.title}\n\n${requirement.body.trim()}` };
}

function authorTask(step: RecipeStep, feedback: readonly InputRow[], answered: readonly QuestionRow[], previousFindings: readonly string[]): string {
  const sections = [`Carry out the "${step.id}" step described in your instructions. It must leave these files complete and valid: ${step.writes.map((file) => `${PRODUCT_DIR}/${file}`).join(", ")}.`];
  if (feedback.length > 0) {
    sections.push(`The person reviewed the current version and asked for these changes. Apply every one of them:\n${feedback.map((input) => `- ${(input.body ?? "").trim()}`).join("\n")}`);
  }
  if (answered.length > 0) {
    sections.push(`Questions asked earlier and the person's answers:\n${answered.map((question) => `Q: ${question.body}\nA: ${question.answer ?? ""}`).join("\n\n")}`);
  }
  if (previousFindings.length > 0) {
    sections.push(`The previous attempt at this step was not accepted:\n${previousFindings.map((line) => `- ${line}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

export function parseFindings(json: string | null): string[] {
  if (json === null) return [];
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}
