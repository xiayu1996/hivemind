import { describe, expect, it } from "vitest";
import {
  axeRunExpression,
  blockingViolations,
  describeAccessibilityViolations,
  type AccessibilityViolation,
} from "./accessibility-audit.js";

const violation = (overrides: Partial<AccessibilityViolation> = {}): AccessibilityViolation => ({
  id: "label",
  impact: "critical",
  help: "表单控件要有标签",
  nodes: ["#phone"],
  ...overrides,
});

describe("blockingViolations", () => {
  it("refuses on the two impacts that mean a person cannot use the page", () => {
    const found = blockingViolations([
      violation({ id: "label", impact: "critical" }),
      violation({ id: "color-contrast", impact: "serious" }),
    ]);

    expect(found.map((entry) => entry.id)).toEqual(["color-contrast", "label"]);
  });

  it("leaves advice out, because a criterion that refuses on advice spends the budget on it", () => {
    expect(blockingViolations([
      violation({ id: "region", impact: "moderate" }),
      violation({ id: "landmark-one-main", impact: "minor" }),
    ])).toEqual([]);
  });

  it("says nothing about an impact axe did not name", () => {
    expect(blockingViolations([violation({ impact: "unknown" })])).toEqual([]);
  });
});

describe("describeAccessibilityViolations", () => {
  it("says which page, which rule and where, in the words the card is written in", () => {
    expect(describeAccessibilityViolations("board.html", [violation()])).toEqual([
      "board.html 上有一处用不了的地方（label）：表单控件要有标签；出现在 #phone",
    ]);
  });
});

describe("axeRunExpression", () => {
  it("is a call, so the browser runs it rather than handing the function back", () => {
    const expression = axeRunExpression();

    expect(expression.startsWith("axe.run(")).toBe(true);
    expect(() => new Function(`return ${expression}`)).not.toThrow();
  });

  it("asks only for the violations: assembling the passes is most of the work and none of the answer", () => {
    expect(axeRunExpression()).toContain('resultTypes: ["violations"]');
  });
});
