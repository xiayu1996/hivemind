import { contractScenarios } from "../domain/contract.ts";
import type { RecipeStep } from "../domain/recipe.ts";
import { runRepoChecks } from "../gates/repo-checks.ts";
import type { RequirementRow } from "../store/store.ts";
import { requestApproval } from "./author.ts";
import { repositoryOf, worktreeOf, type LoopContext } from "./context.ts";
import { evaluate, type Evaluation } from "./evaluate.ts";
import { render } from "./messages.ts";
import type { StepOutcome } from "./outcome.ts";
import { readProduct, readText } from "./product.ts";
import { unavailable } from "./shared.ts";

/**
 * The review: the whole product, as it stands on the integration branch, is
 * checked and judged against every scenario from scratch, then handed to a
 * person as a pull request. Anything that fails goes back to the build as
 * feedback for the planner, like a person's comment would.
 */

export const REVIEW_EVENT = "review.reported";
const SENT_BACK_EVENT = "review.sent_back";
/** Reviews that may send the work back before the loop stops: a review that keeps failing is not converging. */
const MAX_SEND_BACKS = 3;

export async function reviewStep(context: LoopContext, requirement: RequirementRow, step: RecipeStep, buildStepId: string): Promise<StepOutcome> {
  const worktree = worktreeOf(context, requirement);
  const feedback = (await context.store.unconsumedInputs(requirement.id)).filter((input) => input.kind === "comment");
  if (feedback.length > 0) return { kind: "goto", stepId: buildStepId };

  const product = await readProduct(worktree);
  if (product.contract === null || product.project === null) return { kind: "stop", reason: "no_progress", detail: "the product files disappeared before the review" };
  const head = await context.git.head(worktree);

  const checks = await runRepoChecks({ cwd: worktree, project: product.project, run: context.run, env: context.config.childEnv() });
  if (!checks.ok) return sendBack(context, requirement, buildStepId, "review-checks", checks.findings);

  const judge = contractScenarios(product.contract);
  let evaluation: Evaluation = await evaluate(context, { requirement, worktree, candidate: head, contract: product.contract, project: product.project, itemId: null, step: step.id, judge, regression: [] });
  for (let rerun = 1; evaluation.kind === "inconclusive" && rerun < context.config.limits.maxInconclusive; rerun += 1) {
    evaluation = await evaluate(context, { requirement, worktree, candidate: head, contract: product.contract, project: product.project, itemId: null, step: step.id, judge, regression: [] });
  }
  switch (evaluation.kind) {
    case "unavailable":
      return unavailable(context, evaluation.run);
    case "failed":
      return sendBack(context, requirement, buildStepId, "review-evaluation", evaluation.findings);
    case "inconclusive": {
      const questionId = `${requirement.id}-review-inconclusive-${head.slice(0, 7)}`;
      const body = render(context.messages.questions.evaluatorStuck, { reasons: evaluation.reasons.map((reason) => `- ${reason}`).join("\n") });
      await context.store.addQuestion(requirement.id, { id: questionId, body, options: [] });
      await context.board.ask(requirement.boardRef, { id: questionId, body, options: [] });
      return { kind: "wait", waiting: { kind: "answer", questionId }, note: context.messages.status.waitingAnswer };
    }
    case "passed":
      break;
  }

  const scenarios = (evaluation.verdict?.passed ?? []).map((entry) => `- ${entry.id}: ${entry.reason}`).join("\n") || "-";
  const summary = (await readText(worktree, "PRODUCT.md"))?.split("\n").find((line) => line.trim() !== "" && !line.startsWith("#"))?.trim() ?? requirement.title;
  const repository = repositoryOf(context, requirement);
  let link = requirement.branch;
  if (repository.push) {
    await context.git.push(worktree, requirement.branch);
    const repoPath = await context.git.sync(repository);
    link = await context.git.openPullRequest(repoPath, { head: requirement.branch, base: repository.defaultBranch, title: requirement.title, body: `${summary}\n\n${scenarios}` });
  }
  const spent = (await context.store.spentUsd(requirement.id)).toFixed(2);
  const report = render(context.messages.reports.done, { title: requirement.title, summary, scenarios, link, spent });
  await context.store.event(REVIEW_EVENT, { report, link, revision: head }, { requirementId: requirement.id });
  const progress = (await readText(worktree, "PROGRESS.md")) ?? "";
  return requestApproval(context, requirement, { kind: "approval", gate: "milestone", revision: head, onApproval: "next_step" }, { summary: report, decisions: [] }, progress === "" ? [] : [{ name: "PROGRESS.md", content: progress }]);
}

/** Findings of the review become feedback the planner absorbs, exactly as a person's comment would. */
async function sendBack(context: LoopContext, requirement: RequirementRow, buildStepId: string, source: string, findings: readonly string[]): Promise<StepOutcome> {
  const sentBack = await context.store.countEvents(requirement.id, SENT_BACK_EVENT);
  if (sentBack >= MAX_SEND_BACKS) {
    return { kind: "stop", reason: "no_progress", detail: `the final review failed ${sentBack + 1} times:\n${findings.map((line) => `- ${line.split("\n")[0]}`).join("\n")}` };
  }
  await context.store.event(SENT_BACK_EVENT, { source, findings }, { requirementId: requirement.id });
  await context.store.addInputs(requirement.id, [
    { kind: "comment", sourceId: `${source}:${context.now()}`, body: `The final review found:\n${findings.map((line) => `- ${line}`).join("\n")}`, author: "hivemind", at: new Date(context.now()).toISOString() },
  ]);
  return { kind: "goto", stepId: buildStepId };
}
