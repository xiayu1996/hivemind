import { describe, expect, it } from "vitest";
import { planStoryExecution, type SchedulableStory } from "./scheduler.js";

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
});
