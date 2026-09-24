import { randomBytes } from "node:crypto";
import { chooseRecipe } from "../domain/recipe.ts";
import type { LoopContext } from "./context.ts";
import { render } from "./messages.ts";
import { advance } from "./requirement.ts";

/**
 * The main loop. One tick takes new submissions off the board, then gives
 * every live requirement one unit of work, oldest first. Work is sequential on
 * purpose: one writer per integration branch, one session at a time, so no
 * two sessions ever edit the same tree and nothing needs to be merged.
 */

export interface TickResult {
  worked: boolean;
  /** The soonest moment a waiting requirement wants another look, or null when only the board can wake one. */
  wakeAt: number | null;
}

/** Consecutive failures of the loop itself on one requirement before it is stopped for a person to look at. */
const MAX_INTERNAL_ERRORS = 5;

export class Engine {
  readonly #context: LoopContext;
  readonly #errors = new Map<string, number>();

  constructor(context: LoopContext) {
    this.#context = context;
  }

  async tick(): Promise<TickResult> {
    const context = this.#context;
    let worked = await this.#intake();
    let wakeAt: number | null = null;
    for (const requirement of await context.store.allRequirements()) {
      if (requirement.status === "done") continue;
      try {
        const progress = await advance(context, requirement);
        this.#errors.delete(requirement.id);
        worked ||= progress.worked;
        if (progress.wakeAt !== null) wakeAt = wakeAt === null ? progress.wakeAt : Math.min(wakeAt, progress.wakeAt);
      } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        const count = (this.#errors.get(requirement.id) ?? 0) + 1;
        this.#errors.set(requirement.id, count);
        context.log("loop.error", { requirement: requirement.id, count, error: message });
        await context.store.event("loop.error", { count, error: message.slice(0, 4000) }, { requirementId: requirement.id });
        if (count >= MAX_INTERNAL_ERRORS && requirement.status !== "stopped") {
          this.#errors.delete(requirement.id);
          const detail = `hivemind itself failed ${count} times in a row on this requirement: ${message.split("\n")[0] ?? ""}`;
          await context.store.stop(requirement.id, "no_progress", detail);
          await context.board.setStatus(requirement.boardRef, "stopped", detail);
        }
      }
    }
    return { worked, wakeAt };
  }

  /** New submissions become requirements. One naming an unknown repository stays on the board untouched. */
  async #intake(): Promise<boolean> {
    const context = this.#context;
    let accepted = false;
    for (const submission of await context.board.pollSubmissions()) {
      if ((await context.store.requirementByRef(submission.ref)) !== undefined) continue;
      const repository = context.config.repositories.get(submission.repo);
      if (repository === undefined) {
        context.log("intake.unknown_repository", { ref: submission.ref, repo: submission.repo });
        continue;
      }
      const id = `r${randomBytes(4).toString("hex")}`;
      const recipe = chooseRecipe(submission.recipe, [...context.config.recipes.keys()], repository.recipe);
      await context.store.createRequirement({
        id,
        boardRef: submission.ref,
        repo: repository.name,
        title: submission.title,
        body: submission.body,
        recipe,
        budgetUsd: context.config.defaultBudgetUsd,
        branch: `hivemind/${id}`,
      });
      const first = context.config.recipes.get(recipe)?.steps[0]?.id ?? recipe;
      await context.board.setStatus(submission.ref, "working", render(context.messages.status.working, { step: first }));
      accepted = true;
    }
    return accepted;
  }
}
