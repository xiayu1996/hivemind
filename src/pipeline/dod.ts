import { parse } from "yaml";
import { z } from "zod";

const storyId = z.string().regex(/^S-[A-Z0-9]+-\d{2}$/);
const scenarioId = z.string().regex(/^S-[A-Z0-9]+-\d{2}-[a-z0-9]+$/);
const layer = z.enum(["unit", "integration", "snapshot", "e2e", "ui"]);
export type TestLayer = z.infer<typeof layer>;

/**
 * Who produces the evidence for a layer. CODE is test-driven and fast: it owns
 * the layers a test runner settles. Anything that needs a browser and a screen
 * is VERIFY's, so CODE never buys a slow browser round and VERIFY never trusts
 * CODE's account of one. Fixed by the system, not declared by the author, so a
 * DoD cannot move a layer to the side that will not look at it.
 */
export const LAYER_OWNER: Readonly<Record<TestLayer, "code" | "verify">> = {
  unit: "code",
  integration: "code",
  snapshot: "code",
  e2e: "verify",
  ui: "verify",
};

const example = z.object({
  kind: z.enum(["shows", "excludes"]),
  /** Literal text or state a person sees (shows) or must not see (excludes). */
  text: z.string().trim().min(1),
}).strict();

const scenario = z.object({
  id: scenarioId,
  given: z.string().trim().min(1),
  when: z.string().trim().min(1),
  // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external DoD contract.
  then: z.string().trim().min(1),
  layers: z.array(layer).min(1),
  /** Where the shown data comes from: table, event type, existing endpoint. */
  source: z.string().trim().min(1).optional(),
  examples: z.array(example).optional(),
  /**
   * The sample data the given needs on a screen, in plain language, e.g. "one
   * repository with 3 stories, 1 delivered, 1 parked". The repository's seed
   * command receives it verbatim before the interface is reviewed; without it
   * the reviewer looks at whatever the application starts with, which is how a
   * review ends inconclusive for lack of anything to look at.
   */
  seed: z.string().trim().min(1).optional(),
}).strict();

const baseline = z.discriminatedUnion("type", [
  z.object({ type: z.literal("acceptance_test") }).strict(),
  z.object({ type: z.literal("bug_repro") }).strict(),
  z.object({ type: z.literal("exempt"), reason: z.string().trim().min(1) }).strict(),
]);

/**
 * Every criterion has a home: the scenarios whose tests prove it, or a named
 * code check that enforces it as a constraint. A criterion with neither is one
 * only a reviewer's eye can catch, which is how a card gets refused for
 * something no round was ever asked to build.
 */
const criterion = z.union([
  z.object({ text: z.string().trim().min(1), scenarios: z.array(scenarioId).min(1) }).strict(),
  z.object({ text: z.string().trim().min(1), constraint: z.string().trim().min(1) }).strict(),
]);

const dodSchema = z.object({
  story_id: storyId,
  design_summary: z.string().trim().min(1),
  scenarios: z.array(scenario).min(1),
  baseline,
  acceptance_criteria: z.array(criterion).min(1),
  /** What the screen reviewer may not refuse the card for. May be empty, must be decided. */
  out_of_scope: z.array(z.string().trim().min(1)),
  /** Existing pages, routes or services this Story assumes work; their failure is not this card's. */
  relies_on: z.array(z.string().trim().min(1)),
  predicted_footprint: z.array(z.string().trim().min(1)),
  depends_on: z.array(storyId),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const entry of value.scenarios) {
    if (!entry.id.startsWith(`${value.story_id}-`)) {
      context.addIssue({
        code: "custom",
        path: ["scenarios", entry.id],
        message: `scenario id must be namespaced by ${value.story_id}`,
      });
    }
    if (seen.has(entry.id)) {
      context.addIssue({
        code: "custom",
        path: ["scenarios", entry.id],
        message: `duplicate scenario id: ${entry.id}`,
      });
    }
    seen.add(entry.id);
    // A scenario somebody will look at has to say what they will see. "A
    // concise summary" was read one way by CODE and another by the reviewer;
    // a literal example is read one way.
    if (hasScreen(entry)) {
      const kinds = new Set((entry.examples ?? []).map((item) => item.kind));
      if (!kinds.has("shows") || !kinds.has("excludes")) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", entry.id, "examples"],
          message: `${entry.id} is judged on a screen and needs at least one "shows" and one "excludes" example`,
        });
      }
      if (!entry.source) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", entry.id, "source"],
          message: `${entry.id} is judged on a screen and needs a source for what it shows`,
        });
      }
    }
  }
  for (const [index, item] of value.acceptance_criteria.entries()) {
    if (!("scenarios" in item)) continue;
    for (const id of item.scenarios) {
      if (!seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["acceptance_criteria", index],
          message: `criterion "${item.text}" names an undeclared scenario ${id}`,
        });
      }
    }
  }
});

export type DefinitionOfDone = z.infer<typeof dodSchema>;
export type DoDScenario = DefinitionOfDone["scenarios"][number];
export type DoDCriterion = DefinitionOfDone["acceptance_criteria"][number];

/** Whether any of the scenario's layers is settled by looking at a screen. */
export function hasScreen(entry: Pick<DoDScenario, "layers">): boolean {
  return entry.layers.some((item) => LAYER_OWNER[item] === "verify");
}

/** The scenarios VERIFY has to reach in a browser; the rest are proved by tests alone. */
export function screenScenarios(dod: DefinitionOfDone): DoDScenario[] {
  return dod.scenarios.filter((entry) => hasScreen(entry));
}

/** The sample data a screen scenario asks for, or undefined when it declares none. */
export function seedOf(entry: Pick<DoDScenario, "seed">): string | undefined {
  return entry.seed;
}

/** The sentences a reviewer may refuse this scenario for, verbatim. */
export function refusableStatements(entry: DoDScenario): string[] {
  return [entry.then, ...(entry.examples ?? []).map((item) => item.text)];
}

export class DoDValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DoDValidationError";
  }
}

export function parseDoD(source: string): DefinitionOfDone {
  let document: unknown;
  try {
    document = parse(source) as unknown;
  } catch (cause) {
    throw new DoDValidationError(`DoD YAML is invalid: ${(cause as Error).message}`, { cause });
  }
  const result = dodSchema.safeParse(document);
  if (!result.success) {
    const message = result.error.issues.map((issue) => issue.message).join("; ");
    throw new DoDValidationError(`DoD contract is invalid: ${message}`, { cause: result.error });
  }
  return result.data;
}

export interface TestSource {
  path: string;
  content: string;
}

export interface ScenarioCoverage {
  pass: boolean;
  missing: string[];
  unexpected: string[];
}

export function scanScenarioCoverage(dod: DefinitionOfDone, sources: readonly TestSource[]): ScenarioCoverage {
  const declared = new Set(dod.scenarios.map((entry) => entry.id));
  const marked = new Set<string>();
  const marker = /@scenario\s+(S-[A-Z0-9]+-\d{2}-[a-z0-9]+)\b/g;
  for (const source of sources.toSorted((a, b) => a.path.localeCompare(b.path, "en"))) {
    for (const match of source.content.matchAll(marker)) marked.add(match[1]!);
  }
  const missing = [...declared].filter((id) => !marked.has(id)).toSorted();
  const unexpected = [...marked].filter((id) => !declared.has(id)).toSorted();
  return { pass: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}
