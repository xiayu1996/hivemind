import { describe, expect, it } from "vitest";
import { planRegressionSweep, type RegressionSchedulePolicy } from "./scheduler.js";
import type { RegisteredScenario } from "./scenario-registry.js";

const NOW = 1_700_000_000_000;
const policy: RegressionSchedulePolicy = {
  epicPoolIntervalMs: 900_000,
  mainPoolIntervalMs: 86_400_000,
  batchSize: 3,
};

function scenario(scenarioId: string, lastVerifiedAt: number | null, pool: "epic" | "main" = "epic"): RegisteredScenario {
  return { scenarioId, storyId: "S-M2-01", epicId: "M2", pool, lastVerifiedAt };
}

describe("planRegressionSweep", () => {
  it("runs what a merge just invalidated, even while a Story is running", () => {
    expect(planRegressionSweep({
      now: NOW,
      foregroundBusy: true,
      epicScenarios: [],
      mainScenarios: [],
      triggered: ["S-M2-02-a", "S-M2-01-a"],
      policy,
    })).toEqual({ pool: "epic", scenarioIds: ["S-M2-01-a", "S-M2-02-a"], reason: "event" });
  });

  it("gives way to the foreground when it is only polling", () => {
    expect(planRegressionSweep({
      now: NOW,
      foregroundBusy: true,
      epicScenarios: [scenario("S-M2-01-a", null)],
      mainScenarios: [],
      policy,
    })).toBeNull();
  });

  it("sweeps the Epic pool first and takes only a batch", () => {
    const sweep = planRegressionSweep({
      now: NOW,
      foregroundBusy: false,
      epicScenarios: [
        scenario("S-M2-01-a", null),
        scenario("S-M2-01-b", NOW - 3_600_000),
        scenario("S-M2-01-c", NOW - 1_800_000),
        scenario("S-M2-01-d", NOW - 1_000_000),
      ],
      mainScenarios: [scenario("S-VAL-01-a", null, "main")],
      policy,
    });

    expect(sweep).toMatchObject({ pool: "epic", reason: "idle" });
    expect(sweep?.scenarioIds).toEqual(["S-M2-01-a", "S-M2-01-b", "S-M2-01-c"]);
  });

  it("leaves a freshly verified Epic scenario alone", () => {
    expect(planRegressionSweep({
      now: NOW,
      foregroundBusy: false,
      epicScenarios: [scenario("S-M2-01-a", NOW - 60_000)],
      mainScenarios: [],
      policy,
    })).toBeNull();
  });

  it("falls through to the main pool once the Epic pool is current", () => {
    expect(planRegressionSweep({
      now: NOW,
      foregroundBusy: false,
      epicScenarios: [scenario("S-M2-01-a", NOW - 60_000)],
      mainScenarios: [scenario("S-VAL-01-a", NOW - 90_000_000, "main")],
      policy,
    })).toMatchObject({ pool: "main", scenarioIds: ["S-VAL-01-a"], reason: "idle" });
  });

  it("holds the main pool to its own slower clock", () => {
    expect(planRegressionSweep({
      now: NOW,
      foregroundBusy: false,
      epicScenarios: [],
      mainScenarios: [scenario("S-VAL-01-a", NOW - 3_600_000, "main")],
      policy,
    })).toBeNull();
  });

  it("has nothing to do when both pools are current", () => {
    expect(planRegressionSweep({
      now: NOW,
      foregroundBusy: false,
      epicScenarios: [],
      mainScenarios: [],
      policy,
    })).toBeNull();
  });
});
