import { describe, expect, it } from "vitest";
import { summarizeFootprintDeviation } from "./footprint-deviation.js";

describe("S-M2-07-deviation footprint prediction deviation", () => {
  it("treats a predicted module as covering the directories beneath it", () => {
    const summary = summarizeFootprintDeviation([
      { storyId: "S-EPIC1-01", predictedFootprint: ["src"], actualFootprint: ["src/vcs", "src/console"] },
    ]);
    expect(summary).toEqual({
      stories: 1,
      deviationRate: 0,
      unpredictedStoryRate: 0,
      perStory: [{ storyId: "S-EPIC1-01", unpredicted: [], unused: [], deviationRate: 0 }],
    });
  });

  it("separates directories touched without a prediction from predictions never touched", () => {
    const summary = summarizeFootprintDeviation([
      { storyId: "S-EPIC1-01", predictedFootprint: ["src/vcs", "docs"], actualFootprint: ["src/vcs", "src/console"] },
    ]);
    expect(summary.perStory).toEqual([{
      storyId: "S-EPIC1-01",
      unpredicted: ["src/console"],
      unused: ["docs"],
      deviationRate: 0.5,
    }]);
  });

  it("pools the rate across Stories and reports how many under-predicted", () => {
    const summary = summarizeFootprintDeviation([
      { storyId: "S-EPIC1-01", predictedFootprint: ["src/vcs"], actualFootprint: ["src/vcs"] },
      { storyId: "S-EPIC1-02", predictedFootprint: ["src/notion"], actualFootprint: ["src/notion", "src/queue"] },
    ]);
    expect(summary).toMatchObject({
      stories: 2,
      deviationRate: 0.2,
      unpredictedStoryRate: 0.5,
    });
  });

  it("reports a zero rate rather than a division by zero when nothing was predicted or touched", () => {
    expect(summarizeFootprintDeviation([{ storyId: "S-EPIC1-01", predictedFootprint: [], actualFootprint: [] }]))
      .toMatchObject({ stories: 1, deviationRate: 0, unpredictedStoryRate: 0 });
    expect(summarizeFootprintDeviation([])).toEqual({ stories: 0, deviationRate: 0, unpredictedStoryRate: 0, perStory: [] });
  });

  it("orders Stories and directories by a stable key so the projection is reproducible", () => {
    const summary = summarizeFootprintDeviation([
      { storyId: "S-EPIC1-02", predictedFootprint: ["z", "a"], actualFootprint: ["m", "b"] },
      { storyId: "S-EPIC1-01", predictedFootprint: [], actualFootprint: [] },
    ]);
    expect(summary.perStory.map((story) => story.storyId)).toEqual(["S-EPIC1-01", "S-EPIC1-02"]);
    expect(summary.perStory[1]).toMatchObject({ unpredicted: ["b", "m"], unused: ["a", "z"] });
  });
});
