import { describe, expect, it } from "vitest";
import { costCeilingVerdict, renderCostCeilingReport, type CardSpend } from "./cost-ceiling.js";

const spend = (billedUsd: number, subscriptionUsd = 0): CardSpend => ({ billedUsd, subscriptionUsd });

describe("costCeilingVerdict", () => {
  it("lets a card keep going while there is money left", () => {
    expect(costCeilingVerdict(spend(1.5), 5)).toMatchObject({ exceeded: false, remainingUsd: 3.5 });
  });

  it("stops the card once it has reached the ceiling, not only after passing it", () => {
    expect(costCeilingVerdict(spend(5), 5).exceeded).toBe(true);
  });

  it("ignores subscription usage, which costs the same whether the card runs or not", () => {
    // Counting a flat-rate plan's notional price would park a card for money
    // nobody spent, well short of its real allowance.
    const verdict = costCeilingVerdict(spend(0.4, 120), 5);
    expect(verdict).toMatchObject({ exceeded: false, billedUsd: 0.4 });
  });

  it("reports nothing remaining rather than a negative allowance after an overrun", () => {
    // A turn cannot be cut partway, so the last phase can carry the card past
    // the line; the ceiling is a floor on the overrun, not an exact cut.
    expect(costCeilingVerdict(spend(7.2), 5).remainingUsd).toBe(0);
  });
});

describe("the report on a stopped card", () => {
  const verdict = costCeilingVerdict(spend(5.4, 12), 5);
  const report = renderCostCeilingReport("HIVE-12", verdict, spend(5.4, 12), new Map([["CODE", 4.1], ["VERIFY", 1.3]]));

  it("says what was spent and where it went", () => {
    expect(report).toContain("$5.40 of $5.00");
    expect(report).toContain("CODE: $4.10");
    expect(report.indexOf("CODE")).toBeLessThan(report.indexOf("VERIFY"));
  });

  it("names the subscription usage separately so the number is not read as money", () => {
    expect(report).toMatch(/subscription allowance.*flat-rate/s);
  });

  it("says the work is not being judged, because a spend stop reads like a verdict", () => {
    expect(report).toMatch(/not a verdict on the work/);
  });
});
