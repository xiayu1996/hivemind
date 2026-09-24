import { describe, expect, it, vi } from "vitest";
import { parseDoD, type DefinitionOfDone } from "./dod.js";
import { parseTestContract, type TestContract } from "./test-contract.js";
import {
  applyDowngrades,
  evaluateSpecExit,
  renderSpecExitFindings,
  type ChangedPath,
  type ObservedFailure,
  type SpecExitPorts,
  type TestRunReport,
} from "./spec-exit-gate.js";

const TEST_PATHS = ["**/*.test.*", "test/**", "tests/**"];

function dod(extra = ""): DefinitionOfDone {
  return parseDoD(`story_id: S-EPIC1-01
design_summary: Coupons are deducted once.
scenarios:
  - id: S-EPIC1-01-a
    given: a coupon
    when: the order is priced
    then: the discount is deducted once
    layers: [unit]
${extra}baseline:
  type: acceptance_test
acceptance_criteria:
  - text: The total is right.
    scenarios: [S-EPIC1-01-a]
out_of_scope: []
relies_on: []
predicted_footprint: []
depends_on: []
`);
}

function contract(body = ""): TestContract {
  return parseTestContract(`story_id: S-EPIC1-01
mode: full
scenarios:
  - id: S-EPIC1-01-a
    layer: unit
    cases:
      - name: "@scenario S-EPIC1-01-a deducts the coupon once"
        kind: happy
        asserts: the total is 90
      - name: "@scenario S-EPIC1-01-a refuses a second deduction"
        kind: negative
        asserts: the total stays 90
    expected_failure:
      file: test/price.test.ts:12
      assertion: total is 90
      actual: total is 100
      already_passing: [prices an order with no coupon]
${body}`);
}

function failure(over: Partial<ObservedFailure> = {}): ObservedFailure {
  return {
    file: "test/price.test.ts:12",
    testName: "deducts the coupon once",
    kind: "assertion",
    assertion: "expected total is 90",
    actual: "received total is 100",
    scenarioIds: ["S-EPIC1-01-a"],
    ...over,
  };
}

function ports(over: Partial<SpecExitPorts> & { changed?: readonly ChangedPath[]; report?: TestRunReport } = {}) {
  const changed = over.changed ?? [{ path: "test/price.test.ts", existedBefore: false }];
  const report = over.report ?? { failures: [failure()], passed: ["prices an order with no coupon"] };
  const revert = vi.fn(async (_base: string, _paths: readonly string[]) => undefined);
  const commit = vi.fn(async () => ({ commit: "c0ffee", treeSha: "tree-red" }));
  const port: SpecExitPorts = {
    changedPaths: async () => changed,
    revert,
    readTestSources: async () => [{ path: "test/price.test.ts", content: "// @scenario S-EPIC1-01-a" }],
    runTests: async () => report,
    commit,
    currentTreeSha: async () => "tree-red",
    isClean: async () => true,
    ...over,
  };
  return { port, revert, commit };
}

const input = (over: Partial<Parameters<typeof evaluateSpecExit>[0]> = {}) => ({
  cardId: "S-EPIC1-01",
  contract: contract(),
  dod: dod(),
  baseCommit: "base",
  testPathPatterns: TEST_PATHS,
  ports: ports().port,
  ...over,
});

describe("the SPECIFY exit", () => {
  it("freezes a red that is what the contract said it would be", async () => {
    const { port, commit } = ports();
    const verdict = await evaluateSpecExit(input({ ports: port }));

    expect(verdict.passed).toBe(true);
    expect(verdict.frozen).toEqual({ commit: "c0ffee", treeSha: "tree-red", revertedPaths: [] });
    expect(commit).toHaveBeenCalledWith("test(S-EPIC1-01): red");
  });

  it("reverts undeclared source before it measures anything, so the red is about the tree being frozen", async () => {
    const calls: string[] = [];
    const { port, revert } = ports({
      changed: [
        { path: "test/price.test.ts", existedBefore: false },
        { path: "src/price.ts", existedBefore: true },
      ],
    });
    const traced: SpecExitPorts = {
      ...port,
      revert: async (base, paths) => { calls.push(`revert:${paths.join(",")}`); await revert(base, paths); },
      runTests: async () => { calls.push("runTests"); return { failures: [failure()], passed: ["prices an order with no coupon"] }; },
    };

    const verdict = await evaluateSpecExit(input({ ports: traced }));

    expect(verdict.passed).toBe(true);
    expect(calls).toEqual(["revert:src/price.ts", "runTests"]);
    expect(verdict.frozen?.revertedPaths).toEqual(["src/price.ts"]);
  });

  it("keeps source the contract declared as scaffolding", async () => {
    const { port, revert } = ports({
      changed: [
        { path: "test/price.test.ts", existedBefore: false },
        { path: "src/price.ts", existedBefore: false },
      ],
    });

    const verdict = await evaluateSpecExit(input({
      ports: port,
      contract: contract(`scaffolding:
  - file: src/price.ts
    symbol: priceOrder
    signature: "(order: Order) => number"
`),
    }));

    expect(verdict.passed).toBe(true);
    expect(revert).not.toHaveBeenCalled();
  });

  it("refuses a changed existing test that has no recorded reason", async () => {
    const { port } = ports({
      changed: [
        { path: "test/price.test.ts", existedBefore: false },
        { path: "test/orders.test.ts", existedBefore: true },
      ],
    });

    const verdict = await evaluateSpecExit(input({ ports: port }));

    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("test/orders.test.ts");
  });

  it("accepts a changed existing test the contract explains", async () => {
    const { port } = ports({
      changed: [
        { path: "test/price.test.ts", existedBefore: false },
        { path: "test/orders.test.ts", existedBefore: true },
      ],
    });

    const verdict = await evaluateSpecExit(input({
      ports: port,
      contract: contract(`modified_existing_tests:
  - file: test/orders.test.ts
    rationale: the fixture order now carries a coupon field
`),
    }));

    expect(verdict.passed).toBe(true);
  });

  it("refuses a scenario no test file names", async () => {
    const { port } = ports({ readTestSources: async () => [{ path: "test/price.test.ts", content: "no marker here" }] });

    const verdict = await evaluateSpecExit(input({ ports: port }));

    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("S-EPIC1-01-a");
  });

  it("refuses a compile error standing in for a red", async () => {
    const { port } = ports({
      report: { failures: [failure({ kind: "compile_error" })], passed: [] },
    });

    const verdict = await evaluateSpecExit(input({ ports: port }));

    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("only compile_error");
  });

  it("says which reverted paths the vanished red depended on", async () => {
    const { port } = ports({
      changed: [
        { path: "test/price.test.ts", existedBefore: false },
        { path: "src/price.ts", existedBefore: true },
      ],
      report: { failures: [], passed: ["prices an order with no coupon"] },
    });

    const verdict = await evaluateSpecExit(input({ ports: port }));

    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("no test failed");
    expect(verdict.findings[0]).toContain("src/price.ts");
  });

  it("compares the observed failure with expected_failure field by field", async () => {
    const { port } = ports({
      report: { failures: [failure({ file: "test/other.test.ts:3" })], passed: ["prices an order with no coupon"] },
    });

    const verdict = await evaluateSpecExit(input({ ports: port }));

    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("file is test/other.test.ts:3, expected test/price.test.ts:12");
  });

  it("refuses a red whose run lost the checks the contract said were still passing", async () => {
    const { port } = ports({ report: { failures: [failure()], passed: [] } });

    const verdict = await evaluateSpecExit(input({ ports: port }));

    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("claimed these were still passing");
  });

  it("voids the freeze when the tree moved between proving red and committing", async () => {
    const { port } = ports({ commit: async () => ({ commit: "c0ffee", treeSha: "tree-moved" }) });

    const verdict = await evaluateSpecExit(input({ ports: port }));

    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("the evidence is void");
  });

  it("refuses a freeze that left changes behind", async () => {
    const { port } = ports({ isClean: async () => false });

    const verdict = await evaluateSpecExit(input({ ports: port }));

    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("uncommitted changes");
  });

  it("leaves no scenario unproven: a code-layer scenario is tested here or handed to VERIFY", async () => {
    const twoScenarios = `  - id: S-EPIC1-01-b
    given: a screen
    when: the order is shown
    then: the discount is visible
    layers: [unit]
`;
    const { port } = ports();

    const verdict = await evaluateSpecExit(input({ ports: port, dod: dod(twoScenarios) }));

    expect(verdict.passed).toBe(false);
    expect(verdict.findings[0]).toContain("S-EPIC1-01-b");

    const downgraded = await evaluateSpecExit(input({
      ports: ports().port,
      dod: dod(twoScenarios),
      contract: contract(`  - id: S-EPIC1-01-b
    downgraded_to: ui
    rationale: the discount is only observable on the rendered page
`),
    }));
    expect(downgraded.passed).toBe(true);
  });
});

describe("applyDowngrades", () => {
  it("replaces the layers a downgraded scenario can no longer be proved at", () => {
    const updated = applyDowngrades(dod(), parseTestContract(`story_id: S-EPIC1-01
mode: full
scenarios:
  - id: S-EPIC1-01-a
    downgraded_to: ui
    rationale: only observable on the page
`));

    expect(updated.scenarios[0]!.layers).toEqual(["ui"]);
  });

  it("returns the same definition when nothing was downgraded", () => {
    const original = dod();
    expect(applyDowngrades(original, contract())).toBe(original);
  });
});

describe("renderSpecExitFindings", () => {
  it("numbers the findings for the session that has to fix them", () => {
    const text = renderSpecExitFindings({ passed: false, findings: ["first", "second"] });
    expect(text).toContain("1. first");
    expect(text).toContain("2. second");
  });
});
