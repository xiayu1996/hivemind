import { matchesAnyGlob } from "./path-glob.js";
import { LAYER_OWNER, scanScenarioCoverage, type DefinitionOfDone, type TestSource } from "./dod.js";
import { isDowngraded, provenScenarios, type ExpectedFailure, type TestContract } from "./test-contract.js";

/**
 * The deterministic exit of SPECIFY.
 *
 * Seven checks, and **the order is itself a judgment**. The first draft proved
 * the tests red, then cleaned the tree, then froze: source the phase wrote out
 * of bounds could itself be the reason a test failed, so after the cleanup the
 * test was green again and the commit froze a red that was no longer true of
 * the frozen tree. Red is a property of a specific tree, not a certificate
 * earned once.
 *
 * The cleanup's baseline is the commit this execution entered on, not a
 * hardcoded DESIGN commit. A card re-entered by hand, or a delivered card
 * running a narrow regression pass, has legitimate implementation in its tree;
 * reverting to DESIGN would throw away everything the card has done.
 */

export type FailureKind =
  | "assertion"
  | "not_implemented"
  | "compile_error"
  | "module_not_found"
  | "not_executed"
  | "other";

export interface ObservedFailure {
  /** `path:line` of the failing assertion, as the runner reported it. */
  file: string;
  testName: string;
  kind: FailureKind;
  assertion: string;
  actual: string;
  /** Scenario ids named by `@scenario` tags on the failing test. */
  scenarioIds: readonly string[];
}

export interface TestRunReport {
  failures: readonly ObservedFailure[];
  /** Names of checks that passed in the same run; proof the tree is not simply broken. */
  passed: readonly string[];
}

/** One path the phase changed, relative to the worktree root. */
export interface ChangedPath {
  path: string;
  /** Whether the path existed at the baseline. */
  existedBefore: boolean;
}

export interface SpecExitPorts {
  /** Paths changed since `baseCommit`, before any cleanup. */
  changedPaths(baseCommit: string): Promise<readonly ChangedPath[]>;
  /** Reverts the named paths to their baseline content, deleting new files. */
  revert(baseCommit: string, paths: readonly string[]): Promise<void>;
  /** Test sources as they stand after the cleanup, for the marker scan. */
  readTestSources(): Promise<readonly TestSource[]>;
  /** Runs the repository's tests on the tree as it now stands. */
  runTests(): Promise<TestRunReport>;
  /** Commits everything and returns the commit and its tree sha. */
  commit(message: string): Promise<{ commit: string; treeSha: string }>;
  /** The tree sha of the working tree right now. */
  currentTreeSha(): Promise<string>;
  /** Whether the worktree has anything uncommitted left. */
  isClean(): Promise<boolean>;
}

export interface SpecExitInput {
  cardId: string;
  contract: TestContract;
  dod: DefinitionOfDone;
  /** Frozen when this execution entered SPECIFY. */
  baseCommit: string;
  testPathPatterns: readonly string[];
  ports: SpecExitPorts;
}

export interface SpecExitVerdict {
  passed: boolean;
  findings: string[];
  /** Set only when every check passed. */
  frozen?: { commit: string; treeSha: string; revertedPaths: string[] };
}

export { matchesGlob } from "./path-glob.js";

export function isTestPath(path: string, patterns: readonly string[]): boolean {
  return matchesAnyGlob(path, patterns);
}

/** The failure shapes that count as a real red. A test that never ran, a module
 * that would not load or a compile error all mean the run said nothing about
 * whether the behaviour exists. */
const RED_KINDS = new Set<FailureKind>(["assertion", "not_implemented"]);

function mismatchedFields(observed: ObservedFailure, expected: ExpectedFailure): string[] {
  const issues: string[] = [];
  if (!RED_KINDS.has(observed.kind)) issues.push(`kind is ${observed.kind}`);
  if (observed.file !== expected.file) issues.push(`file is ${observed.file}, expected ${expected.file}`);
  if (!observed.assertion.includes(expected.assertion)) {
    issues.push(`assertion is ${observed.assertion}, expected ${expected.assertion}`);
  }
  if (!observed.actual.includes(expected.actual)) {
    issues.push(`actual is ${observed.actual}, expected ${expected.actual}`);
  }
  return issues;
}

/**
 * Runs the seven checks in order and stops at the first that fails, because a
 * later check's answer is only meaningful once the earlier ones hold.
 */
export async function evaluateSpecExit(input: SpecExitInput): Promise<SpecExitVerdict> {
  const { contract, dod, ports, testPathPatterns } = input;
  const findings: string[] = [];
  const fail = (): SpecExitVerdict => ({ passed: false, findings });

  // 1. Tree-pin cleanup, first. Anything outside the test paths that the phase
  // did not declare as scaffolding goes back to the baseline.
  const declaredScaffolding = new Set(contract.scaffolding.map((item) => item.file));
  const changed = await ports.changedPaths(input.baseCommit);
  const toRevert = changed
    .filter((entry) => !isTestPath(entry.path, testPathPatterns) && !declaredScaffolding.has(entry.path))
    .map((entry) => entry.path)
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (toRevert.length > 0) await ports.revert(input.baseCommit, toRevert);

  // 2. Existing tests are either untouched or have a written reason.
  const excused = new Set(contract.modified_existing_tests.map((item) => item.file));
  const unexplained = changed
    .filter((entry) => isTestPath(entry.path, testPathPatterns) && entry.existedBefore && !excused.has(entry.path))
    .map((entry) => entry.path)
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (unexplained.length > 0) {
    findings.push(`existing tests were changed with no reason recorded in modified_existing_tests: ${unexplained.join(", ")}`);
    return fail();
  }

  // 3. Every scenario this phase owns is named by a marker in a test file.
  const owned = new Set(provenScenarios(contract).map((entry) => entry.id));
  const sources = await ports.readTestSources();
  const coverage = scanScenarioCoverage(
    { ...dod, scenarios: dod.scenarios.filter((entry) => owned.has(entry.id)) },
    sources,
  );
  if (coverage.missing.length > 0) {
    findings.push(`no test names these scenarios with an @scenario marker: ${coverage.missing.join(", ")}`);
    return fail();
  }

  // 4. Red, measured on the tree the cleanup left behind.
  const report = await ports.runTests();
  const proofTreeSha = await ports.currentTreeSha();
  const byScenario = new Map<string, ObservedFailure[]>();
  for (const failure of report.failures) {
    for (const scenarioId of failure.scenarioIds) {
      byScenario.set(scenarioId, [...(byScenario.get(scenarioId) ?? []), failure]);
    }
  }
  for (const entry of provenScenarios(contract)) {
    const observed = byScenario.get(entry.id) ?? [];
    const red = observed.filter((failure) => RED_KINDS.has(failure.kind));
    if (red.length === 0) {
      const why = observed.length === 0
        ? "no test failed"
        : `only ${[...new Set(observed.map((failure) => failure.kind))].toSorted().join(", ")}`;
      findings.push(
        `${entry.id} did not produce a red an implementation could turn green: ${why}. ` +
        (toRevert.length > 0
          ? `The tree-pin reverted ${toRevert.join(", ")}; a red that depended on those changes was a red about a tree that is not being frozen.`
          : "Only an assertion failure or a not-implemented error counts; a compile error, a missing module or a test that never ran say nothing about the behaviour."),
      );
    }
  }
  if (findings.length > 0) return fail();

  // 5. The red is the one the contract said it would be, field by field.
  for (const entry of provenScenarios(contract)) {
    const observed = (byScenario.get(entry.id) ?? []).filter((failure) => RED_KINDS.has(failure.kind));
    const matched = observed.some((failure) => mismatchedFields(failure, entry.expected_failure).length === 0);
    if (matched) continue;
    const closest = observed[0];
    findings.push(
      `${entry.id} failed, but not as expected_failure described: ` +
      (closest ? mismatchedFields(closest, entry.expected_failure).join("; ") : "no comparable failure"),
    );
  }
  for (const entry of provenScenarios(contract)) {
    const missing = entry.expected_failure.already_passing.filter((name) => !report.passed.includes(name));
    if (missing.length > 0) {
      findings.push(`${entry.id} claimed these were still passing, and they were not: ${missing.join(", ")}. The tree may simply be broken.`);
    }
  }
  if (findings.length > 0) return fail();

  // 6. Freeze. The red has to be about the tree being frozen, so the tree may
  // not have moved between the proof and the commit.
  const frozen = await ports.commit(`test(${input.cardId}): red`);
  if (frozen.treeSha !== proofTreeSha) {
    findings.push(
      `the tree changed between proving red (${proofTreeSha}) and freezing (${frozen.treeSha}); the evidence is void and the phase must run again`,
    );
    return fail();
  }
  if (!await ports.isClean()) {
    findings.push("the worktree still holds uncommitted changes after the freeze commit");
    return fail();
  }

  // 7. Nothing is left unproven. A scenario with no test at this level must
  // have been handed to VERIFY explicitly; there is no third option.
  const codeLayerScenarios = dod.scenarios
    .filter((entry) => entry.layers.some((layer) => LAYER_OWNER[layer] === "code"))
    .map((entry) => entry.id);
  const downgraded = new Set(contract.scenarios.filter((entry) => isDowngraded(entry)).map((entry) => entry.id));
  const unproven = codeLayerScenarios
    .filter((id) => !owned.has(id) && !downgraded.has(id))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (unproven.length > 0) {
    findings.push(
      `these scenarios declare a layer this phase owns but have neither a test nor a downgrade: ${unproven.join(", ")}`,
    );
    return fail();
  }

  return { passed: true, findings: [], frozen: { ...frozen, revertedPaths: toRevert } };
}

/** What the DoD must become once a scenario is downgraded: the layers it can no
 * longer be proved at are replaced by the one that will prove it. */
export function applyDowngrades(dod: DefinitionOfDone, contract: TestContract): DefinitionOfDone {
  const downgrades = new Map(
    contract.scenarios.filter((entry) => isDowngraded(entry)).map((entry) => [entry.id, entry.downgraded_to]),
  );
  if (downgrades.size === 0) return dod;
  return {
    ...dod,
    scenarios: dod.scenarios.map((entry) => {
      const target = downgrades.get(entry.id);
      if (!target) return entry;
      const kept = entry.layers.filter((layer) => LAYER_OWNER[layer] === "verify");
      return { ...entry, layers: [...new Set([...kept, target])] };
    }),
  };
}

/** Renders the findings for the session that has to fix them. */
export function renderSpecExitFindings(verdict: SpecExitVerdict): string {
  return [
    "The SPECIFY exit refused this attempt. Fix every point and reply with the corrected test contract.",
    ...verdict.findings.map((finding, index) => `${index + 1}. ${finding}`),
  ].join("\n");
}
