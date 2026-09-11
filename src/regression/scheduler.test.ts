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
  it("runs what the foreground is waiting on, even while a Story is running", () => {
    // An Epic ready to open its review request is held until these pass, so
    // the sweep that would release it does not queue behind a Story belonging
    // to some other Epic.
    expect(planRegressionSweep({
      now: NOW,
      foregroundBusy: true,
      epicScenarios: [scenario("S-M2-01-a", 0), scenario("S-M2-02-a", 0)],
      mainScenarios: [],
      triggered: ["S-M2-02-a", "S-M2-01-a"],
      policy,
    })).toEqual({ pool: "epic", scenarioIds: ["S-M2-01-a", "S-M2-02-a"], reason: "event" });
  });

  it("ignores a triggered scenario the registry no longer knows about", () => {
    // Its Story was withdrawn or re-decomposed; there is no Epic to sweep it
    // against, and inventing one would run it in the wrong worktree.
    expect(planRegressionSweep({
      now: NOW,
      foregroundBusy: true,
      epicScenarios: [],
      mainScenarios: [],
      triggered: ["S-GONE-01-a"],
      policy,
    })).toBeNull();
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

describe("one Epic per sweep", () => {
  it("never mixes two Epics into one batch, whatever the batch size allows", () => {
    // Every scenario in a sweep runs in one worktree at one revision. A mixed
    // batch judged the second Epic's scenarios against the first Epic's code
    // and recorded the runs against a revision their Epic never had, so the
    // gate waiting for them could not be satisfied.
    const plan = planRegressionSweep({
      now: 10_000,
      foregroundBusy: false,
      epicScenarios: [
        { scenarioId: "S-A-01-a", storyId: "S-A-01", epicId: "EA", pool: "epic", lastVerifiedAt: null },
        { scenarioId: "S-A-01-b", storyId: "S-A-01", epicId: "EA", pool: "epic", lastVerifiedAt: null },
        { scenarioId: "S-B-01-a", storyId: "S-B-01", epicId: "EB", pool: "epic", lastVerifiedAt: null },
      ],
      mainScenarios: [],
      policy: { epicPoolIntervalMs: 1_000, mainPoolIntervalMs: 1_000, batchSize: 5 },
    });

    expect(plan).toMatchObject({ pool: "epic", scenarioIds: ["S-A-01-a", "S-A-01-b"] });
  });

  it("moves to the next Epic once the first one has been swept", () => {
    const plan = planRegressionSweep({
      now: 10_000,
      foregroundBusy: false,
      epicScenarios: [
        { scenarioId: "S-B-01-a", storyId: "S-B-01", epicId: "EB", pool: "epic", lastVerifiedAt: null },
        { scenarioId: "S-A-01-a", storyId: "S-A-01", epicId: "EA", pool: "epic", lastVerifiedAt: 9_900 },
      ],
      mainScenarios: [],
      policy: { epicPoolIntervalMs: 1_000, mainPoolIntervalMs: 1_000, batchSize: 5 },
    });

    expect(plan).toMatchObject({ scenarioIds: ["S-B-01-a"] });
  });
});
