import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assembleSystemPrompt } from "../agents/prompt.ts";
import { contractScenarios, coverageDigest, coverageDigests, type Contract } from "../domain/contract.ts";
import { pickNext, type Plan, type PlanItem } from "../domain/plan.ts";
import type { Project } from "../domain/project.ts";
import type { RecipeStep } from "../domain/recipe.ts";
import { afterItemFailure } from "../domain/stop.ts";
import { enforceFence, PRODUCT_FILES } from "../gates/fence.ts";
import { runRepoChecks } from "../gates/repo-checks.ts";
import type { ItemRow, QuestionRow, RequirementRow } from "../store/store.ts";
import { requestApproval } from "./author.ts";
import { repositoryOf, runSession, sessionLimits, worktreeOf, type LoopContext } from "./context.ts";
import { evaluate, saveScripts, type Evaluation } from "./evaluate.ts";
import { render } from "./messages.ts";
import type { StepOutcome } from "./outcome.ts";
import { PRODUCT_DIR, productDocuments, readProduct, readText } from "./product.ts";
import { renderProgress } from "./render.ts";
import { revisePlan } from "./revise.ts";
import { unavailable } from "./shared.ts";

/**
 * The build step, one item attempt per call. An attempt is one builder
 * session on the integration branch, and every gate runs inside it: the fence
 * puts back what the builder may not change, the repository's checks run on
 * what is left, and the product is evaluated against the scenarios the item
 * covers plus a replay of every scenario that passed before. Whatever fails
 * goes back into the same session, which keeps everything it has already
 * read. An item that passes is squashed into one commit on the branch.
 */

const builderResultSchema = z
  .object({
    /** For the people following the build: what changed, in their language. */
    summary: z.string().min(1),
    /** Test files written or changed for this item. */
    tests: z.array(z.string().min(1)).default([]),
    /** Only something a person must provide (a credential, an account, a decision). Null otherwise. */
    blocker: z.string().min(1).nullable().default(null),
  })
  .strict();

const BUILDER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export async function buildStep(context: LoopContext, requirement: RequirementRow, step: RecipeStep): Promise<StepOutcome> {
  const worktree = worktreeOf(context, requirement);
  const feedback = (await context.store.unconsumedInputs(requirement.id)).filter((input) => input.kind === "comment");
  if (feedback.length > 0) return revisePlan(context, requirement, { kind: "feedback", comments: feedback });

  const product = await readProduct(worktree);
  if (product.contract === null || product.plan === null || product.project === null || product.problems.size > 0) {
    const problems = [...product.problems].flatMap(([file, found]) => found.map((problem) => `${PRODUCT_DIR}/${file}: ${problem}`));
    return { kind: "stop", reason: "no_progress", detail: `the product files are not usable: ${problems.join("; ") || "acceptance.yaml, plan.yaml or project.yaml is missing"}` };
  }
  const reopened = await context.store.syncItems(requirement.id, product.plan, coverageDigests(product.contract, product.plan));
  if (reopened.length > 0) context.log("items.reopened", { requirement: requirement.id, items: reopened });
  const rows = await context.store.items(requirement.id);
  const next = pickNext(product.plan, new Map(rows.map((row) => [row.id, row.status])));
  if (next.kind === "done") return { kind: "next" };
  if (next.kind === "blocked") return { kind: "stop", reason: "no_progress", detail: `no item can start: ${next.waitingOn.join(", ")} wait on items that cannot pass` };
  const row = rows.find((entry) => entry.id === next.item.id);
  if (row === undefined) throw new Error(`item ${next.item.id} was synced but has no row`);
  return attempt(context, requirement, step, { contract: product.contract, plan: product.plan, project: product.project }, next.item, row);
}

interface BuildProduct {
  contract: Contract;
  plan: Plan;
  project: Project;
}

async function attempt(context: LoopContext, requirement: RequirementRow, step: RecipeStep, product: BuildProduct, item: PlanItem, row: ItemRow): Promise<StepOutcome> {
  const worktree = worktreeOf(context, requirement);
  const trunk = requirement.trunkSha ?? (await context.git.head(worktree));
  // A fresh item starts from the last accepted commit; retries continue from the previous attempt's tree.
  if (row.attempts === 0) await context.git.reset(worktree, trunk, "hard");
  const sessionBase = await context.git.head(worktree);
  const judge = contractScenarios(product.contract, item.covers);
  const passedItems = new Set((await context.store.items(requirement.id)).filter((entry) => entry.status === "passed").map((entry) => entry.id));
  const passedCovers = product.plan.items.filter((entry) => passedItems.has(entry.id)).flatMap((entry) => entry.covers);
  const regression = contractScenarios(product.contract, passedCovers);

  let candidate = sessionBase;
  let evaluation: Evaluation | null = null;
  const evaluateCandidate = () =>
    evaluate(context, { requirement, worktree, candidate, contract: product.contract, project: product.project, itemId: item.id, step: step.id, judge, regression });

  const run = await runSession(context, {
    requirementId: requirement.id,
    itemId: item.id,
    step: step.id,
    session: {
      role: "builder",
      cwd: worktree,
      candidates: context.config.models.roles.builder,
      systemPrompt: assembleSystemPrompt(
        [await context.prompts.layer("base"), await context.prompts.layer("roles/builder"), await context.prompts.layer("steps/build")],
        await productDocuments(worktree),
      ),
      builtinTools: BUILDER_TOOLS,
      tools: [],
      policy: { allowedTools: [...BUILDER_TOOLS, "submit_result"], root: worktree, writable: ["**"], fenced: [PRODUCT_FILES] },
      env: context.config.childEnv(),
      ...sessionLimits(context, "builder"),
    },
    task: builderTask(item, judge, row, await context.store.answeredQuestions(requirement.id)),
    result: { schema: builderResultSchema, description: "Submit when the item is done and the repository's checks pass." },
    check: async (result) => {
      if (result.blocker !== null) return [];
      const restored = await enforceFence(context.git, worktree, sessionBase, "builder");
      const fenceNote = restored.length > 0 ? [`these product files are not yours to change and were put back: ${restored.join(", ")}`] : [];
      const checks = await runRepoChecks({ cwd: worktree, project: product.project, run: context.run, env: context.config.childEnv() });
      if (!checks.ok) return [...fenceNote, ...checks.findings];
      candidate = (await context.git.commit(worktree, `item ${item.id}: ${item.title} (attempt ${row.attempts + 1})`)) ?? (await context.git.head(worktree));
      evaluation = await evaluateCandidate();
      return evaluation.kind === "failed" ? [...fenceNote, ...evaluation.findings] : [];
    },
    maxHandbacks: context.config.limits.maxHandbacks,
  });

  if (!run.ok) {
    if (run.reason === "unavailable" || run.needsHuman) return unavailable(context, run);
    return failed(context, requirement, item, run.findings.length > 0 ? run.findings : [run.detail]);
  }
  if (run.value.blocker !== null) {
    const questionId = `${requirement.id}-${item.id}-blocked-${row.attempts + 1}`;
    const body = render(context.messages.questions.builderBlocked, { item: item.title, blocker: run.value.blocker });
    await context.store.addQuestion(requirement.id, { id: questionId, body, options: [] });
    await context.board.ask(requirement.boardRef, { id: questionId, body, options: [] });
    return { kind: "wait", waiting: { kind: "answer", questionId }, note: context.messages.status.waitingAnswer };
  }

  // The session accepted; settle what its last check could not decide on the builder's behalf.
  let settled: Evaluation = evaluation ?? (await evaluateCandidate());
  for (let rerun = 1; settled.kind === "inconclusive" && rerun < context.config.limits.maxInconclusive; rerun += 1) {
    settled = await evaluateCandidate();
  }
  switch (settled.kind) {
    case "unavailable":
      return unavailable(context, settled.run);
    case "failed":
      return failed(context, requirement, item, settled.findings);
    case "inconclusive": {
      const questionId = `${requirement.id}-${item.id}-inconclusive-${row.attempts + 1}`;
      const body = render(context.messages.questions.evaluatorStuck, { reasons: settled.reasons.map((reason) => `- ${reason}`).join("\n") });
      await context.store.addQuestion(requirement.id, { id: questionId, body, options: [] });
      await context.board.ask(requirement.boardRef, { id: questionId, body, options: [] });
      return { kind: "wait", waiting: { kind: "answer", questionId }, note: context.messages.status.waitingAnswer };
    }
    case "passed": {
      const sha = await passItem(context, requirement, product, item, trunk, settled);
      // After the last item the review follows at once and shows the same tree, so a milestone there would ask twice.
      const passed = new Set((await context.store.items(requirement.id)).filter((entry) => entry.status === "passed").map((entry) => entry.id));
      const last = product.plan.items.every((entry) => passed.has(entry.id));
      if (!item.milestone || last) return { kind: "again" };
      const progress = (await readText(worktree, "PROGRESS.md")) ?? "";
      const summary = render(context.messages.reports.milestone, { item: item.title });
      return requestApproval(context, requirement, { kind: "approval", gate: "milestone", revision: sha, onApproval: "same_step" }, { summary, decisions: [] }, [{ name: "PROGRESS.md", content: progress }]);
    }
  }
}

/** Squashes the item's attempts into one commit on the branch and returns it. */
async function passItem(
  context: LoopContext,
  requirement: RequirementRow,
  { contract, plan }: BuildProduct,
  item: PlanItem,
  trunk: string,
  evaluation: Extract<Evaluation, { kind: "passed" }>,
): Promise<string> {
  const worktree = worktreeOf(context, requirement);
  await saveScripts(worktree, evaluation.scripts);
  // PROGRESS.md rides in the commit that produces the sha, so it records this pass before the store does.
  // oxlint-disable-next-line oxc/no-map-spread -- a handful of rows; copying leaves the query result untouched
  const rows = (await context.store.items(requirement.id)).map((row) => (row.id === item.id ? { ...row, status: "passed" as const, feedback: null } : row));
  await writeFile(join(worktree, PRODUCT_DIR, "PROGRESS.md"), renderProgress(plan, rows));
  // Every attempt of this item becomes one commit on top of the last accepted one.
  await context.git.reset(worktree, trunk, "soft");
  const sha = (await context.git.commit(worktree, `item ${item.id}: ${item.title}`)) ?? (await context.git.head(worktree));
  await context.store.markItemPassed(requirement.id, item.id, sha, coverageDigest(contract, item.covers));
  await context.store.setTrunk(requirement.id, sha);
  // A pass ends the streak of revisions made without progress.
  await context.store.clearStepFailures(requirement.id);
  const repository = repositoryOf(context, requirement);
  if (repository.push) {
    try {
      await context.git.push(worktree, requirement.branch);
    } catch (error) {
      // The branch is pushed again after the next item and before the pull request; a push that failed here is only late.
      context.log("push.failed", { requirement: requirement.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return sha;
}

async function failed(context: LoopContext, requirement: RequirementRow, item: PlanItem, findings: readonly string[]): Promise<StepOutcome> {
  const row = await context.store.recordItemFailure(requirement.id, item.id, findings);
  switch (afterItemFailure(row.attempts, row.replans, context.config.limits)) {
    case "retry":
      return { kind: "again" };
    case "replan":
      return revisePlan(context, requirement, { kind: "stuck", item, findings });
    case "stop":
      return {
        kind: "stop",
        reason: "no_progress",
        detail: `item ${item.id} (${item.title}) did not pass after ${row.attempts} attempts and ${row.replans} replans. Last findings:\n${findings.map((line) => `- ${line.split("\n")[0]}`).join("\n")}`,
      };
  }
}

function builderTask(item: PlanItem, scenarios: ReturnType<typeof contractScenarios>, row: ItemRow, answered: readonly QuestionRow[]): string {
  const sections = [`Build plan item ${item.id} (${item.kind}): ${item.title}\n\nGoal: ${item.goal}`];
  if (scenarios.length > 0) {
    const listed = scenarios.map((scenario) => {
      const where = scenario.surface === "web" ? `page ${scenario.page ?? ""}` : `command \`${scenario.command ?? ""}\``;
      return `- ${scenario.id} ${scenario.title} (${where}): given ${scenario.given}; when ${scenario.when}; then ${scenario.then}`;
    });
    sections.push(`When you submit, the running product will be judged against these acceptance scenarios, and every scenario that passed before must still pass:\n${listed.join("\n")}`);
  }
  const findings: unknown = row.feedback === null ? [] : JSON.parse(row.feedback);
  if (Array.isArray(findings) && findings.length > 0) {
    sections.push(
      `This is attempt ${row.attempts + 1}. The tree already holds the previous attempt's work, which was refused for these reasons:\n${findings.map((finding) => `- ${String(finding)}`).join("\n")}`,
    );
  }
  if (answered.length > 0) {
    sections.push(`Questions a person answered earlier:\n${answered.map((question) => `Q: ${question.body}\nA: ${question.answer ?? ""}`).join("\n\n")}`);
  }
  return sections.join("\n\n");
}
