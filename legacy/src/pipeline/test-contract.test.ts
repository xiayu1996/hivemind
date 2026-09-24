import { describe, expect, it } from "vitest";
import {
  isDowngraded,
  parseTestContract,
  provenScenarios,
  TestContractValidationError,
} from "./test-contract.js";

/** A contract that passes, so each case below changes exactly one thing. */
function contract(body: string): string {
  return `story_id: S-EPIC12-03\nmode: full\n${body}`;
}

const PROVEN = `scenarios:
  - id: S-EPIC12-03-active
    layer: unit
    cases:
      - name: "@scenario S-EPIC12-03-active keeps an active row"
        kind: happy
        asserts: "returns the row with state ACTIVE"
      - name: "@scenario S-EPIC12-03-active refuses an unknown state"
        kind: negative
        asserts: "throws UnknownStateError"
    expected_failure:
      file: src/rows.test.ts:12
      assertion: expect(row.state).toBe("ACTIVE")
      actual: undefined
      already_passing:
        - the module loads
`;

describe("what a contract must declare", () => {
  it("accepts a scenario proved at a layer CODE can run", () => {
    const parsed = parseTestContract(contract(PROVEN));

    expect(parsed.mode).toBe("full");
    expect(provenScenarios(parsed)).toHaveLength(1);
    expect(parsed.scaffolding).toEqual([]);
    expect(parsed.modified_existing_tests).toEqual([]);
  });

  it("refuses a scenario with no expected_failure, because the exit compares against it field by field", () => {
    const source = contract(PROVEN.replace(/    expected_failure:[\s\S]*$/, ""));

    expect(() => parseTestContract(source)).toThrow(TestContractValidationError);
    expect(() => parseTestContract(source)).toThrow(/expected_failure/);
  });

  it("refuses a scenario whose only case is a happy one", () => {
    const source = contract(PROVEN.replace(/      - name: "@scenario S-EPIC12-03-active refuses[\s\S]*?asserts: "throws UnknownStateError"\n/, ""));

    expect(() => parseTestContract(source)).toThrow(/at least one boundary or negative case/);
  });

  it("refuses a scenario with no happy case at all", () => {
    const source = contract(PROVEN.replace("kind: happy", "kind: boundary"));

    expect(() => parseTestContract(source)).toThrow(/needs at least one happy case/);
  });

  it("refuses a browser layer on a proved scenario: e2e and ui belong to VERIFY", () => {
    const source = contract(PROVEN.replace("layer: unit", "layer: e2e"));

    expect(() => parseTestContract(source)).toThrow(TestContractValidationError);
  });

  it("takes a browser layer only as a declared downgrade, with a reason", () => {
    const parsed = parseTestContract(contract(`scenarios:
  - id: S-EPIC12-03-visual
    downgraded_to: ui
    rationale: the spacing is only observable once the page renders
`));

    const entry = parsed.scenarios[0]!;
    expect(isDowngraded(entry)).toBe(true);
    expect(provenScenarios(parsed)).toEqual([]);
  });

  it("refuses a downgrade with no reason, so nothing drops a scenario silently", () => {
    const source = contract(`scenarios:
  - id: S-EPIC12-03-visual
    downgraded_to: ui
`);

    expect(() => parseTestContract(source)).toThrow(TestContractValidationError);
  });

  it("refuses a scenario id belonging to another Story", () => {
    const source = contract(PROVEN.replace("S-EPIC12-03-active", "S-EPIC12-04-active"));

    expect(() => parseTestContract(source)).toThrow(/namespaced by S-EPIC12-03/);
  });

  it("refuses the same scenario id twice", () => {
    const source = contract(`${PROVEN}${PROVEN.replace("scenarios:\n", "")}`);

    expect(() => parseTestContract(source)).toThrow(/duplicate scenario id/);
  });

  it("refuses a contract with no scenario at all", () => {
    expect(() => parseTestContract("story_id: S-EPIC12-03\nmode: full\nscenarios: []\n")).toThrow(TestContractValidationError);
  });

  it("keeps narrow as a declared mode, because a regression rerun proves one signature", () => {
    const parsed = parseTestContract(`story_id: S-EPIC12-03\nmode: narrow\n${PROVEN}`);

    expect(parsed.mode).toBe("narrow");
  });

  it("refuses a mode it does not know", () => {
    expect(() => parseTestContract(`story_id: S-EPIC12-03\nmode: partial\n${PROVEN}`)).toThrow(TestContractValidationError);
  });

  it("refuses an undeclared key rather than ignoring it", () => {
    expect(() => parseTestContract(contract(`${PROVEN}notes: everything is fine\n`))).toThrow(/notes/);
  });

  it("names the scaffolding it wrote outside the test paths, signature and all", () => {
    const parsed = parseTestContract(contract(`${PROVEN}scaffolding:
  - file: src/rows.ts
    symbol: readRow
    signature: "export function readRow(id: string): Row"
`));

    expect(parsed.scaffolding).toEqual([{ file: "src/rows.ts", symbol: "readRow", signature: "export function readRow(id: string): Row" }]);
  });

  it("requires a reason beside every existing test it modified", () => {
    const source = contract(`${PROVEN}modified_existing_tests:
  - file: src/rows.test.ts
`);

    expect(() => parseTestContract(source)).toThrow(/rationale/);
  });

  it("reports broken YAML as a contract problem rather than throwing the parser's error", () => {
    expect(() => parseTestContract("story_id: [unterminated\n")).toThrow(TestContractValidationError);
  });
});
