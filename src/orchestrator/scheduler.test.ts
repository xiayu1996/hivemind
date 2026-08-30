import { describe, expect, it } from "vitest";
import { planStoryExecution, storiesShareHotspot, type SchedulableStory } from "./scheduler.js";

function story(id: string, predictedFootprint: readonly string[], dependsOn: readonly string[] = []): SchedulableStory {
  return { id, dependsOn, predictedFootprint };
}

describe("planStoryExecution", () => {
  it("S-M2-03-disjoint releases ready Stories with separate business areas together", () => {
    const result = planStoryExecution([
      story("S-CHECKOUT-01", ["checkout/pricing"]),
      story("S-DELIVERY-01", ["delivery/tracking"]),
    ], []);

    expect(result).toEqual({ kind: "planned", batches: [["S-CHECKOUT-01", "S-DELIVERY-01"]] });
  });

  it("S-M2-03-intersect separates ready Stories whose business areas overlap", () => {
    const result = planStoryExecution([
      story("S-CHECKOUT-01", ["checkout"]),
      story("S-CHECKOUT-02", ["checkout/pricing"]),
    ], []);

    expect(result).toEqual({ kind: "planned", batches: [["S-CHECKOUT-01"], ["S-CHECKOUT-02"]] });
  });

  it("S-M2-03-cycle reports a circular dependency without releasing a partial batch", () => {
    const result = planStoryExecution([
      story("S-CATALOG-01", ["catalog"], ["S-CATALOG-02"]),
      story("S-CATALOG-02", ["inventory"], ["S-CATALOG-01"]),
      story("S-DELIVERY-01", ["delivery"]),
    ], []);

    expect(result).toEqual({ kind: "dependency_cycle", cycle: ["S-CATALOG-01", "S-CATALOG-02", "S-CATALOG-01"], batches: [] });
  });

  it("S-M2-03-hotspot detects that two different business areas cover the same configured conflict hotspot", () => {
    expect(storiesShareHotspot(
      story("S-CHECKOUT-01", ["checkout/pricing"]),
      story("S-CHECKOUT-02", ["checkout/receipts"]),
      ["checkout"],
    )).toBe(true);
  });

  it("S-M2-03-mixed releases only dependency-ready non-conflicting Stories in stable batches", () => {
    const result = planStoryExecution([
      story("S-ACCOUNT-01", ["accounts"]),
      story("S-CHECKOUT-01", ["checkout"], ["S-ACCOUNT-01"]),
      story("S-DELIVERY-01", ["delivery"]),
      story("S-CHECKOUT-02", ["checkout/pricing"]),
    ], []);

    expect(result).toEqual({
      kind: "planned",
      batches: [
        ["S-ACCOUNT-01", "S-DELIVERY-01", "S-CHECKOUT-02"],
        ["S-CHECKOUT-01"],
      ],
    });
  });
});
