import { describe, expect, it } from "vitest";
import { DoDValidationError, parseDoD, scanScenarioCoverage } from "./dod.js";

const yaml = `
story_id: S-EPIC12-03
design_summary: Deduct the coupon before tax.
scenarios:
  - id: S-EPIC12-03-a
    given: A taxable cart
    when: A flat coupon is applied
    then: Tax uses the discounted subtotal
    layers: [unit, integration]
baseline:
  type: acceptance_test
acceptance_criteria:
  - Tax is calculated from the discounted subtotal
predicted_footprint: [src/cart]
depends_on: []
`;

describe("parseDoD", () => {
  it("parses the complete YAML contract", () => {
    const dod = parseDoD(yaml);
    expect(dod.story_id).toBe("S-EPIC12-03");
    expect(dod.scenarios[0]?.layers).toEqual(["unit", "integration"]);
  });

  it("rejects a non-global scenario id and duplicate ids", () => {
    expect(() => parseDoD(yaml.replace("S-EPIC12-03-a", "scenario-1"))).toThrow(DoDValidationError);
    const duplicate = yaml.replace("baseline:", `  - id: S-EPIC12-03-a
    given: Other
    when: Other
    then: Other
    layers: [unit]
baseline:`);
    expect(() => parseDoD(duplicate)).toThrow(/duplicate scenario id/);
  });

  it("requires a reason when a test baseline is exempt", () => {
    const exempt = yaml.replace("type: acceptance_test", "type: exempt");
    expect(() => parseDoD(exempt)).toThrow(DoDValidationError);
    expect(() => parseDoD(exempt.replace("type: exempt", "type: exempt\n  reason: External certification"))).not.toThrow();
  });
});

describe("scanScenarioCoverage", () => {
  it("fails closed when a DoD scenario has no test marker", () => {
    const result = scanScenarioCoverage(parseDoD(yaml), [
      { path: "cart.test.ts", content: "test('tax', () => {})" },
    ]);
    expect(result).toEqual({ pass: false, missing: ["S-EPIC12-03-a"], unexpected: [] });
  });

  it("accepts markers and reports markers not declared by the DoD", () => {
    const result = scanScenarioCoverage(parseDoD(yaml), [
      { path: "cart.test.ts", content: "// @scenario S-EPIC12-03-a\n// @scenario S-EPIC12-99-z" },
    ]);
    expect(result).toEqual({ pass: false, missing: [], unexpected: ["S-EPIC12-99-z"] });
  });
});
