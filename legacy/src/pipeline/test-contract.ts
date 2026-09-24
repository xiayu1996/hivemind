import { parse } from "yaml";
import { z } from "zod";
import { LAYER_OWNER, type TestLayer } from "./dod.js";

const storyId = z.string().regex(/^S-[A-Z0-9]+-\d{2}$/);
const scenarioId = z.string().regex(/^S-[A-Z0-9]+-\d{2}-[a-z0-9]+$/);

/** The layers a test runner settles. The browser layers belong to VERIFY, and a
 * contract naming one is refused rather than silently handed to a phase that
 * cannot run it. */
const codeLayer = z.enum(
  (Object.keys(LAYER_OWNER) as TestLayer[]).filter((layer) => LAYER_OWNER[layer] === "code") as [TestLayer, ...TestLayer[]],
);

const verifyLayer = z.enum(
  (Object.keys(LAYER_OWNER) as TestLayer[]).filter((layer) => LAYER_OWNER[layer] === "verify") as [TestLayer, ...TestLayer[]],
);

/**
 * One test. `kind` is declared rather than inferred because the exit needs to
 * know a scenario has more than a positive control: a happy case passes under
 * a skeleton implementation as readily as under a correct one.
 */
const testCase = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(["happy", "boundary", "negative"]),
  /** The observable boundary being asserted, naming the expected value. */
  asserts: z.string().trim().min(1),
}).strict();

/**
 * What the red run must look like, field by field. Compared literally at the
 * exit: a heuristic over failure text would let a compile error or an
 * unrelated crash stand in for the assertion that was supposed to fail.
 */
const expectedFailure = z.object({
  file: z.string().trim().min(1),
  assertion: z.string().trim().min(1),
  actual: z.string().trim().min(1),
  /** Checks that passed in the same run, proving the tree is not simply broken. */
  already_passing: z.array(z.string().trim().min(1)).default([]),
}).strict();

const reuse = z.object({
  covered_by: z.array(z.string().trim().min(1)).default([]),
  rationale: z.string().trim().min(1),
}).strict();

/** A scenario proved by tests this phase writes. */
const provenScenario = z.object({
  id: scenarioId,
  layer: codeLayer,
  cases: z.array(testCase).min(1),
  expected_failure: expectedFailure,
  /** Non-test success criteria: what a log or a state must show. */
  observations: z.array(z.string().trim().min(1)).default([]),
  reuse: reuse.optional(),
}).strict();

/**
 * A scenario no test at this level can settle. It is downgraded to a browser
 * layer and proved by VERIFY -- there is deliberately no third option where
 * nobody proves it.
 */
const downgradedScenario = z.object({
  id: scenarioId,
  downgraded_to: verifyLayer,
  rationale: z.string().trim().min(1),
}).strict();

const contractScenario = z.union([provenScenario, downgradedScenario]);

/**
 * A placeholder this phase is allowed to write outside the test paths. Anything
 * not declared here is reverted by the exit's tree-pin, so the declaration is
 * what separates "made the test loadable" from "implemented the feature".
 */
const scaffolding = z.object({
  file: z.string().trim().min(1),
  symbol: z.string().trim().min(1),
  signature: z.string().trim().min(1),
}).strict();

const modifiedTest = z.object({
  file: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
}).strict();

const testContractSchema = z.object({
  story_id: storyId,
  /** `narrow` is a regression rerun: one failure signature, the rest untouched. */
  mode: z.enum(["full", "narrow"]),
  scenarios: z.array(contractScenario).min(1),
  scaffolding: z.array(scaffolding).default([]),
  modified_existing_tests: z.array(modifiedTest).default([]),
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
    if (!("cases" in entry)) continue;
    // A scenario with only a positive control cannot tell a skeleton from a
    // correct implementation, which is the failure mode this whole phase exists
    // to close.
    const kinds = new Set(entry.cases.map((item) => item.kind));
    if (!kinds.has("happy")) {
      context.addIssue({
        code: "custom",
        path: ["scenarios", entry.id, "cases"],
        message: `${entry.id} needs at least one happy case`,
      });
    }
    if (!kinds.has("boundary") && !kinds.has("negative")) {
      context.addIssue({
        code: "custom",
        path: ["scenarios", entry.id, "cases"],
        message: `${entry.id} needs at least one boundary or negative case; a happy case alone passes under a skeleton implementation`,
      });
    }
  }
});

export type TestContract = z.infer<typeof testContractSchema>;
export type TestContractScenario = TestContract["scenarios"][number];
export type ProvenScenario = Extract<TestContractScenario, { cases: unknown }>;
export type DowngradedScenario = Extract<TestContractScenario, { downgraded_to: unknown }>;
export type ExpectedFailure = ProvenScenario["expected_failure"];

export function isDowngraded(entry: TestContractScenario): entry is DowngradedScenario {
  return "downgraded_to" in entry;
}

export function provenScenarios(contract: TestContract): ProvenScenario[] {
  return contract.scenarios.filter((entry): entry is ProvenScenario => !isDowngraded(entry));
}

export class TestContractValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TestContractValidationError";
  }
}

type Issue = { code: string; path: PropertyKey[]; message: string; errors?: Issue[][] };

/**
 * Flattens issues into one line each, naming the field.
 *
 * A scenario is a union of "proved here" and "downgraded to VERIFY", and zod
 * reports a failed union as a bare "Invalid input" with the branch errors
 * nested underneath. That message is read by the phase that has to fix it, so
 * the branch it most nearly matched is unfolded instead: the scenario that
 * forgot `expected_failure` is told which field is missing, not that its shape
 * is wrong somehow.
 */
function describeIssues(issues: readonly Issue[], prefix: PropertyKey[] = []): string[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors && issue.errors.length > 0) {
      const nearest = issue.errors.toSorted((a, b) => a.length - b.length)[0] ?? [];
      return describeIssues(nearest, path);
    }
    return [path.length > 0 ? `${path.join(".")}: ${issue.message}` : issue.message];
  });
}

export function parseTestContract(source: string): TestContract {
  let document: unknown;
  try {
    document = parse(source) as unknown;
  } catch (cause) {
    throw new TestContractValidationError(`test contract YAML is invalid: ${(cause as Error).message}`, { cause });
  }
  const result = testContractSchema.safeParse(document);
  if (!result.success) {
    const message = describeIssues(result.error.issues as unknown as Issue[]).join("; ");
    throw new TestContractValidationError(`test contract is invalid: ${message}`, { cause: result.error });
  }
  return result.data;
}
