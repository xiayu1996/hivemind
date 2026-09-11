import { describe, expect, it } from "vitest";
import { DoDValidationError, LAYER_OWNER, hasScreen, parseDoD, refusableStatements, scanScenarioCoverage, seedOf } from "./dod.js";

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
  - text: Tax is calculated from the discounted subtotal
    scenarios: [S-EPIC12-03-a]
  - text: The cart page stays read-only
    constraint: the guard policy denies write tools in VERIFY
out_of_scope: []
relies_on: []
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

  it("rejects a criterion with no scenario and no constraint, or naming an undeclared scenario", () => {
    const orphan = yaml.replace("    scenarios: [S-EPIC12-03-a]\n", "");
    expect(() => parseDoD(orphan)).toThrow(DoDValidationError);
    const undeclared = yaml.replace("scenarios: [S-EPIC12-03-a]", "scenarios: [S-EPIC12-03-zz]");
    expect(() => parseDoD(undeclared)).toThrow(/undeclared scenario S-EPIC12-03-zz/);
  });

  it("requires a shows and an excludes example plus a source for any scenario judged on a screen", () => {
    const onScreen = yaml.replace("layers: [unit, integration]", "layers: [unit, ui]");
    expect(() => parseDoD(onScreen)).toThrow(/needs at least one "shows" and one "excludes" example/);
    expect(() => parseDoD(onScreen)).toThrow(/needs a source/);
    const complete = onScreen.replace("layers: [unit, ui]", `layers: [unit, ui]
    source: carts.discounted_subtotal
    examples:
      - kind: shows
        text: "Tax: $8.10 on $90.00"
      - kind: excludes
        text: "Tax: $9.00 on $100.00"`);
    const dod = parseDoD(complete);
    expect(hasScreen(dod.scenarios[0]!)).toBe(true);
    expect(refusableStatements(dod.scenarios[0]!)).toEqual([
      "Tax uses the discounted subtotal",
      "Tax: $8.10 on $90.00",
      "Tax: $9.00 on $100.00",
    ]);
    expect(LAYER_OWNER.ui).toBe("verify");
    expect(LAYER_OWNER.unit).toBe("code");
  });

  it("carries the sample data a screen scenario asks for, and leaves it optional", () => {
    const dod = parseDoD(yaml.replace("    layers: [unit, integration]\n", "    layers: [unit, integration]\n    seed: one cart with two taxable items\n"));
    expect(seedOf(dod.scenarios[0]!)).toBe("one cart with two taxable items");
    expect(seedOf(parseDoD(yaml).scenarios[0]!)).toBeUndefined();
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
