import { parse } from "yaml";
import { z } from "zod";

const storyId = z.string().regex(/^S-[A-Z0-9]+-\d{2}$/);
const scenarioId = z.string().regex(/^S-[A-Z0-9]+-\d{2}-[a-z0-9]+$/);
const layer = z.enum(["unit", "integration", "snapshot", "e2e", "ui"]);

const baseline = z.discriminatedUnion("type", [
  z.object({ type: z.literal("acceptance_test") }).strict(),
  z.object({ type: z.literal("bug_repro") }).strict(),
  z.object({ type: z.literal("exempt"), reason: z.string().trim().min(1) }).strict(),
]);

const dodSchema = z.object({
  story_id: storyId,
  design_summary: z.string().trim().min(1),
  scenarios: z.array(z.object({
    id: scenarioId,
    given: z.string().trim().min(1),
    when: z.string().trim().min(1),
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external DoD contract.
    then: z.string().trim().min(1),
    layers: z.array(layer).min(1),
  }).strict()).min(1),
  baseline,
  acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
  predicted_footprint: z.array(z.string().trim().min(1)),
  depends_on: z.array(storyId),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const scenario of value.scenarios) {
    if (!scenario.id.startsWith(`${value.story_id}-`)) {
      context.addIssue({
        code: "custom",
        path: ["scenarios", scenario.id],
        message: `scenario id must be namespaced by ${value.story_id}`,
      });
    }
    if (seen.has(scenario.id)) {
      context.addIssue({
        code: "custom",
        path: ["scenarios", scenario.id],
        message: `duplicate scenario id: ${scenario.id}`,
      });
    }
    seen.add(scenario.id);
  }
});

export type DefinitionOfDone = z.infer<typeof dodSchema>;

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
  const declared = new Set(dod.scenarios.map((scenario) => scenario.id));
  const marked = new Set<string>();
  const marker = /@scenario\s+(S-[A-Z0-9]+-\d{2}-[a-z0-9]+)\b/g;
  for (const source of sources.toSorted((a, b) => a.path.localeCompare(b.path, "en"))) {
    for (const match of source.content.matchAll(marker)) marked.add(match[1]!);
  }
  const missing = [...declared].filter((id) => !marked.has(id)).toSorted();
  const unexpected = [...marked].filter((id) => !declared.has(id)).toSorted();
  return { pass: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}
