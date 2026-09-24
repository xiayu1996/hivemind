import { describe, expect, it } from "vitest";
import { parseDoD, type DefinitionOfDone } from "./dod.js";
import { dodVersion, scenarioVersion, scenarioVersions } from "./dod-version.js";

const BASE = `story_id: S-EPIC1-01
design_summary: Coupons are deducted once and shown on the receipt.
scenarios:
  - id: S-EPIC1-01-a
    given: an order with a coupon
    when: the order is priced
    then: the discount is deducted once
    layers: [unit, integration]
    source: orders table
    seed: one order of 100 with a 10 percent coupon
    examples:
      - kind: shows
        text: "Total  90"
      - kind: excludes
        text: "Total  80"
  - id: S-EPIC1-01-b
    given: an order with no coupon
    when: the order is priced
    then: the total is unchanged
    layers: [unit]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: The total is right.
    scenarios: [S-EPIC1-01-a]
  - text: Prices never go negative.
    constraint: pricing invariant check
out_of_scope: [the receipt's typography]
relies_on: [the pricing service]
predicted_footprint: [src/price]
depends_on: []
`;

const dod = (source = BASE): DefinitionOfDone => parseDoD(source);
const edited = (from: string, to: string): DefinitionOfDone => {
  if (!BASE.includes(from)) throw new Error(`fixture does not contain ${from}`);
  return dod(BASE.replace(from, to));
};

describe("the card's acceptance version", () => {
  it("is stable for the same contract written twice", () => {
    expect(dodVersion(dod())).toBe(dodVersion(dod()));
  });

  it("changes when the data behind a scenario changes, even though no sentence did", () => {
    expect(dodVersion(edited("source: orders table", "source: order_events stream")))
      .not.toBe(dodVersion(dod()));
  });

  it("changes when the sample data a reviewer will look at changes", () => {
    expect(dodVersion(edited("seed: one order of 100 with a 10 percent coupon", "seed: one order of 100 with a 20 percent coupon")))
      .not.toBe(dodVersion(dod()));
  });

  it("changes when whitespace inside a literal example changes, because that literal is what a person sees", () => {
    expect(dodVersion(edited('text: "Total  90"', 'text: "Total 90"')))
      .not.toBe(dodVersion(dod()));
  });

  it("ignores the order of things that are sets rather than sequences", () => {
    const reordered = dod(BASE
      .replace("layers: [unit, integration]", "layers: [integration, unit]")
      .replace(`      - kind: shows
        text: "Total  90"
      - kind: excludes
        text: "Total  80"`, `      - kind: excludes
        text: "Total  80"
      - kind: shows
        text: "Total  90"`));

    expect(dodVersion(reordered)).toBe(dodVersion(dod()));
  });

  it("ignores what only steers scheduling", () => {
    expect(dodVersion(edited("predicted_footprint: [src/price]", "predicted_footprint: [src/price, src/receipt]")))
      .toBe(dodVersion(dod()));
  });
});

describe("one scenario's own version", () => {
  it("moves only for the scenario that was edited, so the rest of the card is not torn down", () => {
    const before = scenarioVersions(dod());
    const after = scenarioVersions(edited("then: the discount is deducted once", "then: the discount is deducted once per order"));

    expect(after["S-EPIC1-01-a"]).not.toBe(before["S-EPIC1-01-a"]);
    expect(after["S-EPIC1-01-b"]).toBe(before["S-EPIC1-01-b"]);
  });

  it("moves for every scenario when a globally binding field changes", () => {
    const before = scenarioVersions(dod());
    const after = scenarioVersions(edited("out_of_scope: [the receipt's typography]", "out_of_scope: []"));

    expect(after["S-EPIC1-01-a"]).not.toBe(before["S-EPIC1-01-a"]);
    expect(after["S-EPIC1-01-b"]).not.toBe(before["S-EPIC1-01-b"]);
  });

  it("moves for both scenarios when a criterion changes hands", () => {
    const before = scenarioVersions(dod());
    const after = scenarioVersions(edited("scenarios: [S-EPIC1-01-a]", "scenarios: [S-EPIC1-01-b]"));

    expect(after["S-EPIC1-01-a"]).not.toBe(before["S-EPIC1-01-a"]);
    expect(after["S-EPIC1-01-b"]).not.toBe(before["S-EPIC1-01-b"]);
  });

  it("refuses to version a scenario the DoD does not declare", () => {
    expect(() => scenarioVersion(dod(), "S-EPIC1-01-z")).toThrow(/no scenario/);
  });
});
