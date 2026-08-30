import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { diagnoseRetryLimit, renderRetryReport, retryLimits } from "./retry-limits.js";

describe("retryLimits", () => {
  it("reads all four ceilings from config so no call site keeps its own default", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const config = await ConfigStore.load(client);

    await expect(retryLimits(config)).resolves.toEqual({
      maxInnerLoopRounds: 6,
      maxPhaseReentries: 3,
      maxContinueRetries: 8,
      maxRegressionReopens: 2,
    });

    await config.set("retry.maxInnerLoopRounds", 3, "test");
    await expect(retryLimits(config)).resolves.toMatchObject({ maxInnerLoopRounds: 3 });
    client.close();
  });
});

describe("diagnoseRetryLimit", () => {
  it("calls a flat curve on the same scenarios a requirement problem", () => {
    const diagnosis = diagnoseRetryLimit([["S-1-a", "S-1-b"], ["S-1-a", "S-1-b"], ["S-1-a", "S-1-b"]]);

    expect(diagnosis).toMatchObject({
      curve: [2, 2, 2],
      side: "requirement",
      persistent: ["S-1-a", "S-1-b"],
      regressed: [],
    });
    expect(diagnosis.reason).toContain("no progress");
  });

  it("calls a scenario that passed and failed again a system problem", () => {
    const diagnosis = diagnoseRetryLimit([["S-1-a", "S-1-b"], ["S-1-b"], ["S-1-a", "S-1-b"]]);

    expect(diagnosis).toMatchObject({ side: "system", regressed: ["S-1-a"] });
    expect(diagnosis.reason).toContain("S-1-a");
  });

  it("does not blame the requirement when the failing set was still shrinking", () => {
    expect(diagnoseRetryLimit([["S-1-a", "S-1-b", "S-1-c"], ["S-1-a", "S-1-b"], ["S-1-a"]]))
      .toMatchObject({ side: "system", persistent: ["S-1-a"] });
  });

  it("does not blame the requirement on the evidence of a single round", () => {
    expect(diagnoseRetryLimit([["S-1-a"]])).toMatchObject({ side: "system" });
  });

  it("says so plainly when the budget went before any round finished", () => {
    expect(diagnoseRetryLimit([])).toMatchObject({ curve: [], side: "system" });
    expect(diagnoseRetryLimit([]).reason).toContain("before any verification round");
  });
});

describe("renderRetryReport", () => {
  it("puts the curve and the two-way conclusion in front of the human", () => {
    const report = renderRetryReport(
      "S-EPIC1-01",
      "verify_loop_exceeded",
      diagnoseRetryLimit([["S-1-a", "S-1-b"], ["S-1-a", "S-1-b"]]),
    );

    expect(report).toContain("S-EPIC1-01 stopped: verify_loop_exceeded");
    expect(report).toContain("round 1: 2 failing -> round 2: 2 failing");
    expect(report).toContain("Most likely side: requirement");
    expect(report).toContain("Never passed: S-1-a, S-1-b");
  });

  it("reads sensibly when nothing was verified at all", () => {
    expect(renderRetryReport("S-EPIC1-01", "retry_limit_exceeded", diagnoseRetryLimit([])))
      .toContain("no verification round completed");
  });
});
