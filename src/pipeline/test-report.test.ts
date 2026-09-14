import { describe, expect, it } from "vitest";
import { classifyFailure, parseTestReport, TestReportParseError } from "./test-report.js";

const REPORT = JSON.stringify({
  testResults: [
    {
      name: "/repo/src/pricing/total.test.ts",
      assertionResults: [
        {
          fullName: "@scenario S-DEMO-01-coupon deducts the discount once",
          status: "failed",
          failureMessages: [
            "AssertionError: expected 200 to be 180\n  at /repo/src/pricing/total.test.ts:14:22\n  at run",
          ],
        },
        { fullName: "@scenario S-DEMO-01-empty rejects an empty basket", status: "passed", failureMessages: [] },
      ],
    },
  ],
});

describe("parseTestReport", () => {
  it("takes a failure apart so the exit can compare it with what was predicted", () => {
    const report = parseTestReport(REPORT, "/repo");
    expect(report.failures).toEqual([{
      file: "src/pricing/total.test.ts:14",
      testName: "@scenario S-DEMO-01-coupon deducts the discount once",
      kind: "assertion",
      assertion: "AssertionError: expected 200 to be 180",
      actual: "200",
      scenarioIds: ["S-DEMO-01-coupon"],
    }]);
    expect(report.passed).toEqual(["@scenario S-DEMO-01-empty rejects an empty basket"]);
  });

  it("ignores whatever the runner printed before the JSON", () => {
    expect(parseTestReport(`> vitest run\n\n${REPORT}`, "/repo").failures).toHaveLength(1);
  });

  it("reads a test that never ran as a different answer from one that disagreed", () => {
    const skipped = JSON.stringify({
      testResults: [{
        name: "/repo/a.test.ts",
        assertionResults: [{ fullName: "skipped one", status: "pending", failureMessages: [] }],
      }],
    });
    expect(parseTestReport(skipped, "/repo").failures[0]).toMatchObject({ kind: "not_executed" });
  });

  it("refuses output it cannot read rather than reporting an empty run", () => {
    expect(() => parseTestReport("Segmentation fault", "/repo")).toThrow(TestReportParseError);
    expect(() => parseTestReport('{"ok":true}', "/repo")).toThrow(TestReportParseError);
  });

  it("separates a red from a tree that would not build at all", () => {
    expect(classifyFailure("AssertionError: expected 1 to be 2")).toBe("assertion");
    expect(classifyFailure("Error: Cannot find module './total.js'")).toBe("module_not_found");
    expect(classifyFailure("TS2339: Property 'total' does not exist")).toBe("compile_error");
    expect(classifyFailure("Error: not implemented")).toBe("not_implemented");
    expect(classifyFailure("the process exited with signal SIGSEGV")).toBe("other");
  });
});
