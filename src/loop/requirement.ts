import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { hasWebSurface } from "../domain/contract.ts";
import { nextStepIndex, type Recipe, type StepFacts } from "../domain/recipe.ts";
import { budgetExceeded } from "../domain/stop.ts";
import type { RequirementRow, Waiting } from "../store/store.ts";
import { authorStep } from "./author.ts";
import { buildStep } from "./build.ts";
import { repositoryOf, worktreeOf, type LoopContext } from "./context.ts";
import { render } from "./messages.ts";
import type { StepOutcome } from "./outcome.ts";
import { readProduct } from "./product.ts";
import { REVIEW_EVENT, reviewStep } from "./review.ts";

/**
 * Moves one requirement forward by one unit of work: take in what people
 * wrote, settle a wait if its answer arrived, then run the current step once
 * and record what it asks for. All state lives in the store and in the
 * repository, so a crash anywhere repeats at most the unit it interrupted.
 */

export interface Progress {
  worked: boolean;
  /** When this requirement next needs a look even if nothing changes on the board. */
  wakeAt: number | null;
}

/** How often a requirement that only a person can unblock checks whether they did. */
const HUMAN_RECHECK_MS = 10 * 60_000;

export async function advance(context: LoopContext, requirement: RequirementRow): Promise<Progress> {
  await ingestInputs(context, requirement);
  let current = await reload(context, requirement.id);

  if (current.status === "stopped") {
    if (!(await resumeStopped(context, current))) return idle();
    current = await reload(context, current.id);
  }
  if (current.status === "waiting") {
    const settled = await settleWait(context, current);
    if (settled !== null) return idle(settled);
    current = await reload(context, current.id);
  }
  if (current.status !== "active") return idle();

  const spent = await context.store.spentUsd(current.id);
  if (budgetExceeded(spent, current.budgetUsd)) {
    await apply(context, current, { kind: "stop", reason: "budget", detail: render(context.messages.status.stoppedBudget, { spent: spent.toFixed(2), budget: current.budgetUsd.toFixed(2) }) });
    return { worked: true, wakeAt: null };
  }

  await ensureWorkspace(context, current);
  current = await reload(context, current.id);
  const recipe = recipeOf(context, current);
  const index = nextStepIndex(recipe, current.stepIndex, await facts(context, current));
  if (index === null) {
    await finish(context, current);
    return { worked: true, wakeAt: null };
  }
  const step = recipe.steps[index];
  if (step === undefined) throw new Error(`recipe ${recipe.name} has no step ${index}`);
  if (index !== current.stepIndex) {
    await context.store.setStep(current.id, index, step.id);
    current = await reload(context, current.id);
  }
  await context.board.setStatus(current.boardRef, "working", render(context.messages.status.working, { step: step.id }));

  const buildStepId = recipe.steps.find((entry) => entry.kind === "build")?.id ?? step.id;
  let outcome: StepOutcome;
  switch (step.kind) {
    case "author":
      outcome = await authorStep(context, current, step);
      break;
    case "build":
      outcome = await buildStep(context, current, step);
      break;
    case "review":
      outcome = await reviewStep(context, current, step, buildStepId);
      break;
  }
  await apply(context, await reload(context, current.id), outcome);
  return { worked: true, wakeAt: null };
}

async function apply(context: LoopContext, requirement: RequirementRow, outcome: StepOutcome): Promise<void> {
  const recipe = recipeOf(context, requirement);
  switch (outcome.kind) {
    case "again":
      return;
    case "next":
      return moveOn(context, requirement, recipe);
    case "goto": {
      const index = recipe.steps.findIndex((step) => step.id === outcome.stepId);
      if (index < 0) throw new Error(`recipe ${recipe.name} has no step ${outcome.stepId}`);
      await context.store.setStep(requirement.id, index, outcome.stepId);
      return;
    }
    case "wait":
      await context.store.setWaiting(requirement.id, outcome.waiting);
      await context.board.setStatus(requirement.boardRef, "needs_input", outcome.note);
      return;
    case "stop":
      await context.store.stop(requirement.id, outcome.reason, outcome.detail);
      await context.board.setStatus(requirement.boardRef, "stopped", outcome.detail.split("\n")[0] ?? null);
      await context.board.report(requirement.boardRef, {
        id: `${requirement.id}-stopped-${context.now()}`,
        title: requirement.title,
        body: render(context.messages.reports.stopped, { title: requirement.title, detail: outcome.detail }),
      });
      return;
    case "done":
      await context.store.finish(requirement.id);
      await context.board.report(requirement.boardRef, { id: `${requirement.id}-done`, title: requirement.title, body: outcome.report });
      await context.board.setStatus(requirement.boardRef, "done", render(context.messages.status.done, { link: outcome.link }));
      return;
  }
}

async function moveOn(context: LoopContext, requirement: RequirementRow, recipe: Recipe): Promise<void> {
  const index = nextStepIndex(recipe, requirement.stepIndex + 1, await facts(context, requirement));
  if (index === null) return finish(context, requirement);
  const step = recipe.steps[index];
  if (step !== undefined) await context.store.setStep(requirement.id, index, step.id);
}

async function finish(context: LoopContext, requirement: RequirementRow): Promise<void> {
  const reported = await context.store.lastEvent(requirement.id, REVIEW_EVENT);
  const report = typeof reported?.report === "string" ? reported.report : requirement.title;
  const link = typeof reported?.link === "string" ? reported.link : requirement.branch;
  await apply(context, requirement, { kind: "done", report, link });
}

/** Returns null once the wait is over, otherwise when to look again (null inside the Progress means "when the board changes"). */
async function settleWait(context: LoopContext, requirement: RequirementRow): Promise<number | null> {
  const waiting = JSON.parse(requirement.waiting ?? "null") as Waiting | null;
  if (waiting === null) {
    await context.store.resume(requirement.id, "nothing to wait for");
    return null;
  }
  const inputs = await context.store.unconsumedInputs(requirement.id);
  const comments = inputs.filter((input) => input.kind === "comment");
  switch (waiting.kind) {
    case "approval": {
      const approvals = inputs.filter((input) => input.kind === "approval");
      const matching = approvals.find((input) => input.gate === waiting.gate && input.revision === waiting.revision);
      // An approval of any other revision approves something that is no longer what would be built.
      await context.store.consumeInputs(approvals.map((input) => input.sourceId));
      if (matching !== undefined) {
        await context.store.decideApproval(requirement.id, waiting.gate, waiting.revision, "approved");
        await context.store.resume(requirement.id, `${waiting.gate} approved`);
        if (waiting.onApproval === "next_step") await moveOn(context, await reload(context, requirement.id), recipeOf(context, requirement));
        return null;
      }
      if (comments.length > 0) {
        // The comments stay unconsumed: the step that runs next reads them as the changes to make.
        await context.store.decideApproval(requirement.id, waiting.gate, waiting.revision, "revise");
        await context.store.resume(requirement.id, `${waiting.gate} revision requested`);
        return null;
      }
      return Number.POSITIVE_INFINITY;
    }
    case "answer": {
      if (comments.length === 0) return Number.POSITIVE_INFINITY;
      await context.store.answerQuestion(waiting.questionId, comments.map((input) => (input.body ?? "").trim()).join("\n\n"));
      // A person answered, so whatever was stuck gets its attempts back.
      for (const item of await context.store.items(requirement.id)) {
        if (item.status !== "passed" && item.attempts > 0) await context.store.resetItemAttempts(requirement.id, item.id);
      }
      await context.store.clearStepFailures(requirement.id);
      await context.store.resume(requirement.id, "question answered");
      return null;
    }
    case "provider": {
      const now = context.now();
      const due = waiting.until ?? Date.parse(requirement.updatedAt) + HUMAN_RECHECK_MS;
      if (now < due) return due;
      await context.store.resume(requirement.id, "checking whether a model is usable again");
      return null;
    }
  }
}

/** A comment on a requirement that stopped for lack of progress is a person's guidance: continue with it. */
async function resumeStopped(context: LoopContext, requirement: RequirementRow): Promise<boolean> {
  if (requirement.stopReason !== "no_progress") return false;
  const comments = (await context.store.unconsumedInputs(requirement.id)).filter((input) => input.kind === "comment");
  if (comments.length === 0) return false;
  for (const item of await context.store.items(requirement.id)) {
    if (item.status !== "passed") await context.store.resetItemAttempts(requirement.id, item.id);
  }
  await context.store.clearStepFailures(requirement.id);
  await context.store.resume(requirement.id, "a person commented on the stopped requirement");
  return true;
}

async function ingestInputs(context: LoopContext, requirement: RequirementRow): Promise<void> {
  const polled = await context.board.pollInputs(requirement.boardRef, requirement.inputCursor);
  // The board also shows what hivemind itself wrote; only people's inputs count.
  await context.store.addInputs(requirement.id, polled.inputs);
  if (polled.cursor !== requirement.inputCursor) await context.store.setInputCursor(requirement.id, polled.cursor);
}

/**
 * The requirement's own worktree on its integration branch, created from the
 * default branch the first time. Scratch space for spikes is excluded from git
 * for every worktree of the repository.
 */
async function ensureWorkspace(context: LoopContext, requirement: RequirementRow): Promise<void> {
  const worktree = worktreeOf(context, requirement);
  if (!(await exists(join(worktree, ".git")))) {
    const repository = repositoryOf(context, requirement);
    const repoPath = await context.git.sync(repository);
    const start = `refs/remotes/origin/${repository.defaultBranch}`;
    if ((await context.git.resolve(repoPath, start)) === null) {
      throw new Error(`repository ${repository.name} has no ${repository.defaultBranch} branch on origin; push an initial commit first`);
    }
    await context.git.ensureBranch(repoPath, requirement.branch, start);
    await context.git.addWorktree(repoPath, worktree, requirement.branch);
    await excludeScratch(repoPath);
  }
  if (requirement.trunkSha === null) await context.store.setTrunk(requirement.id, await context.git.head(worktree));
}

async function excludeScratch(repoPath: string): Promise<void> {
  const exclude = join(repoPath, ".git", "info", "exclude");
  const line = ".hivemind/scratch/";
  let current = "";
  try {
    current = await readFile(exclude, "utf8");
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (!current.split("\n").includes(line)) await appendFile(exclude, `${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
}

async function facts(context: LoopContext, requirement: RequirementRow): Promise<StepFacts> {
  const product = await readProduct(worktreeOf(context, requirement));
  return { hasWebSurface: product.contract !== null && hasWebSurface(product.contract), hasArchitecture: product.hasArchitecture };
}

function recipeOf(context: LoopContext, requirement: RequirementRow): Recipe {
  const recipe = context.config.recipes.get(requirement.recipe);
  if (recipe === undefined) throw new Error(`requirement ${requirement.id} uses recipe ${requirement.recipe}, which is not loaded`);
  return recipe;
}

async function reload(context: LoopContext, id: string): Promise<RequirementRow> {
  const row = await context.store.requirement(id);
  if (row === undefined) throw new Error(`requirement ${id} disappeared`);
  return row;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    // Any failure to stat means there is nothing usable at the path; the caller creates it.
    return false;
  }
}

function idle(wakeAt: number | null = null): Progress {
  return { worked: false, wakeAt: wakeAt === Number.POSITIVE_INFINITY ? null : wakeAt };
}
