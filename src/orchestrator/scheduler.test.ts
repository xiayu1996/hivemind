// @scenario S-M2-03-disjoint
// @scenario S-M2-03-intersect
// @scenario S-M2-03-hotspot
// @scenario S-M2-03-cycle
// @scenario S-M2-03-mixed
// @scenario S-M2-03-stranded
// @scenario S-M2-03-dispatchable
import { describe, expect, it } from "vitest";
import {
  dispatchableStories,
  planStoryExecution,
  storiesShareHotspot,
  type SchedulableStory,
  type StoryExecutionPlan,
} from "./scheduler.js";

function story(id: string, predictedFootprint: readonly string[], dependsOn: readonly string[] = []): SchedulableStory {
  return { id, dependsOn, predictedFootprint };
}

const cases: readonly {
  id: string;
  stories: readonly SchedulableStory[];
  hotspots: readonly string[];
  expected: StoryExecutionPlan;
  hotspotStories?: readonly [SchedulableStory, SchedulableStory];
}[] = [
  {
    id: "S-M2-03-disjoint",
    stories: [
      story("S-CHECKOUT-01", ["checkout/pricing"]),
      story("S-DELIVERY-01", ["delivery/tracking"]),
    ],
    hotspots: [],
    expected: { kind: "planned", batches: [["S-CHECKOUT-01", "S-DELIVERY-01"]] },
  },
  {
    id: "S-M2-03-intersect",
    stories: [
      story("S-CHECKOUT-01", ["checkout"]),
      story("S-CHECKOUT-02", ["checkout/pricing"]),
    ],
    hotspots: [],
    expected: { kind: "planned", batches: [["S-CHECKOUT-01"], ["S-CHECKOUT-02"]] },
  },
  {
    id: "S-M2-03-hotspot",
    stories: [
      story("S-CHECKOUT-01", ["checkout/pricing"]),
      story("S-CHECKOUT-02", ["checkout/receipts"]),
    ],
    hotspots: ["checkout"],
    expected: { kind: "planned", batches: [["S-CHECKOUT-01"], ["S-CHECKOUT-02"]] },
    hotspotStories: [
      story("S-CHECKOUT-01", ["checkout/pricing"]),
      story("S-CHECKOUT-02", ["checkout/receipts"]),
    ],
  },
  {
    id: "S-M2-03-cycle",
    stories: [
      story("S-CATALOG-01", ["catalog"], ["S-CATALOG-02"]),
      story("S-CATALOG-02", ["inventory"], ["S-CATALOG-01"]),
      story("S-DELIVERY-01", ["delivery"]),
    ],
    hotspots: [],
    expected: { kind: "dependency_cycle", cycle: ["S-CATALOG-01", "S-CATALOG-02", "S-CATALOG-01"], batches: [] },
  },
  {
    id: "S-M2-03-mixed",
    stories: [
      story("S-ACCOUNT-01", ["accounts"]),
      story("S-CHECKOUT-01", ["checkout"], ["S-ACCOUNT-01"]),
      story("S-DELIVERY-01", ["delivery"]),
      story("S-CHECKOUT-02", ["checkout/pricing"]),
    ],
    hotspots: [],
    expected: {
      kind: "planned",
      batches: [
        ["S-ACCOUNT-01", "S-DELIVERY-01", "S-CHECKOUT-02"],
        ["S-CHECKOUT-01"],
      ],
    },
  },
];

describe("planStoryExecution", () => {
  it.each(cases)("$id", ({ stories, hotspots, expected, hotspotStories }) => {
    expect(planStoryExecution(stories, hotspots)).toEqual(expected);
    if (hotspotStories) expect(storiesShareHotspot(...hotspotStories, hotspots)).toBe(true);
  });
});

describe("S-M2-03-stranded unsatisfiable dependencies", () => {
  it("names the Stories it could not schedule instead of dropping them from the plan", () => {
    const plan = planStoryExecution([
      { id: "S-EPIC1-01", dependsOn: [], predictedFootprint: ["src/a"] },
      { id: "S-EPIC1-02", dependsOn: ["S-EPIC1-99"], predictedFootprint: ["src/b"] },
    ], []);

    expect(plan).toEqual({
      kind: "unschedulable",
      stranded: ["S-EPIC1-02"],
      batches: [["S-EPIC1-01"]],
    });
  });
});

describe("S-M2-03-dispatchable narrowing a repository to what can run now", () => {
  it("drops finished Stories and the dependencies they already satisfied", () => {
    const plan = planStoryExecution(dispatchableStories([
      { id: "S-EPIC1-01", state: "DELIVERED", dependsOn: [], predictedFootprint: ["src/a"] },
      { id: "S-EPIC1-02", state: "QUEUED", dependsOn: ["S-EPIC1-01"], predictedFootprint: ["src/b"] },
      { id: "S-EPIC1-03", state: "CODE", dependsOn: [], predictedFootprint: ["src/c"] },
    ]), []);

    expect(plan).toEqual({ kind: "planned", batches: [["S-EPIC1-02", "S-EPIC1-03"]] });
  });

  it("keeps a dependency that has not finished, so the order still holds", () => {
    const plan = planStoryExecution(dispatchableStories([
      { id: "S-EPIC1-01", state: "CODE", dependsOn: [], predictedFootprint: ["src/a"] },
      { id: "S-EPIC1-02", state: "QUEUED", dependsOn: ["S-EPIC1-01"], predictedFootprint: ["src/b"] },
    ]), []);

    expect(plan).toEqual({ kind: "planned", batches: [["S-EPIC1-01"], ["S-EPIC1-02"]] });
  });

  it("leaves a Story parked for a human out of the plan entirely", () => {
    expect(dispatchableStories([
      { id: "S-EPIC1-01", state: "NEEDS_INPUT", dependsOn: [], predictedFootprint: ["src/a"] },
      { id: "S-EPIC1-02", state: "HUMAN_PARKED", dependsOn: [], predictedFootprint: ["src/b"] },
      { id: "S-EPIC1-03", state: "FAILED", dependsOn: [], predictedFootprint: ["src/c"] },
    ])).toEqual([]);
  });
});
