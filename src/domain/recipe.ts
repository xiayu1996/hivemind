import { z } from "zod";

/**
 * A recipe is data: which steps a requirement goes through, in order. Step
 * kinds (author, build, review) are code; how they are composed for a big
 * greenfield product, a feature in an existing product or a small change is a
 * file under `config/recipes/`.
 */

export const STEP_CONDITIONS = ["always", "has_web_surface", "missing_architecture"] as const;

const stepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    kind: z.enum(["author", "build", "review"]),
    /** File name under prompts/steps/, without the extension. Author and review steps only. */
    prompt: z.string().min(1).optional(),
    /** Files under .hivemind/ an author step must leave behind, validated before it counts as done. */
    writes: z.array(z.string().min(1)).default([]),
    when: z.enum(STEP_CONDITIONS).default("always"),
    /**
     * always: a person approves every revision. on_change: only when some
     * product file changed since the revision a person last approved, which
     * keeps an unchanged architecture from asking twice while a changed one
     * never goes unseen, whatever the author says about it.
     */
    approval: z.enum(["always", "never", "on_change"]).default("never"),
    /** The board touchpoint an approval of this step is shown as. Required unless approval is never. */
    gate: z.enum(["product", "architecture", "milestone"]).optional(),
    /** The author may ask for time-boxed research spikes before finishing. */
    research: z.boolean().default(false),
  })
  .strict();

export const recipeSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: z.string().min(1),
    steps: z.array(stepSchema).min(1),
  })
  .strict();

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeStep = Recipe["steps"][number];

/** The files a build step reads; some author step before it has to write each of them. */
const BUILD_INPUTS = ["acceptance.yaml", "plan.yaml", "project.yaml"] as const;

export function checkRecipe(recipe: Recipe): string[] {
  const findings: string[] = [];
  const ids = new Set<string>();
  const written = new Set<string>();
  let builds = 0;
  for (const step of recipe.steps) {
    if (ids.has(step.id)) findings.push(`recipe ${recipe.name}: step id ${step.id} is used twice`);
    ids.add(step.id);
    if (step.kind === "author" && step.prompt === undefined) findings.push(`recipe ${recipe.name}: author step ${step.id} needs a prompt`);
    if (step.kind === "author" && step.writes.length === 0) findings.push(`recipe ${recipe.name}: author step ${step.id} writes nothing`);
    if (step.approval !== "never" && step.gate === undefined) findings.push(`recipe ${recipe.name}: step ${step.id} asks for approval but names no gate`);
    if (step.kind === "build") {
      builds += 1;
      for (const input of BUILD_INPUTS) {
        if (!written.has(input)) findings.push(`recipe ${recipe.name}: build step ${step.id} needs ${input} written by an earlier author step`);
      }
    }
    for (const file of step.writes) written.add(file);
  }
  if (builds !== 1) findings.push(`recipe ${recipe.name}: exactly one build step is required, found ${builds}`);
  const last = recipe.steps.at(-1);
  if (last?.kind !== "review") findings.push(`recipe ${recipe.name}: the last step must be a review, so a person sees the result before it is done`);
  return findings;
}

export interface StepFacts {
  hasWebSurface: boolean;
  hasArchitecture: boolean;
}

export function stepApplies(step: RecipeStep, facts: StepFacts): boolean {
  switch (step.when) {
    case "always":
      return true;
    case "has_web_surface":
      return facts.hasWebSurface;
    case "missing_architecture":
      return !facts.hasArchitecture;
  }
}

/** Index of the first applicable step at or after `from`, or null when the recipe is finished. */
export function nextStepIndex(recipe: Recipe, from: number, facts: StepFacts): number | null {
  for (let index = from; index < recipe.steps.length; index += 1) {
    const step = recipe.steps[index];
    if (step !== undefined && stepApplies(step, facts)) return index;
  }
  return null;
}

export function buildStepIndex(recipe: Recipe): number {
  return recipe.steps.findIndex((step) => step.kind === "build");
}

/**
 * Deterministic choice: what the submitter asked for when it exists, otherwise
 * the repository's own default (greenfield for a repository that holds no
 * product yet, feature for one that does, as its configuration says).
 */
export function chooseRecipe(requested: string | null, available: readonly string[], repositoryDefault: string): string {
  if (requested !== null && available.includes(requested)) return requested;
  return repositoryDefault;
}
