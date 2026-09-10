import { describe, expect, it } from "vitest";
import { isEnvironmentFailure, splitScenarioFailures } from "./failure-classification.js";

describe("isEnvironmentFailure", () => {
  it("reads the failures the box caused as environmental", () => {
    // All four are rejections the 2026-09-05 run spent inner-loop rounds on.
    expect(isEnvironmentFailure("the page returned 404: the service was not running")).toBe(true);
    expect(isEnvironmentFailure("connection refused on http://localhost:5173")).toBe(true);
    expect(isEnvironmentFailure("listen EADDRINUSE: address already in use :::5173")).toBe(true);
    expect(isEnvironmentFailure("screenshot does not exist (round-4.png)")).toBe(true);
    expect(isEnvironmentFailure("chromium failed to launch")).toBe(true);
  });

  it("reads a 500 the reviewer's own harness raised as environmental", () => {
    // The wording S-E3OVERVIEW-01 was parked by on 2026-09-10: the 500 came
    // from the stub server the reviewer had written itself, in Chinese because
    // the reviewer answers in the language of the board.
    expect(isEnvironmentFailure("首页最后一组正确显示昨日失败及原因，但点击该事项的任务入口后在 /tasks 页面看到 HTTP 500，入口不可用。")).toBe(true);
    expect(isEnvironmentFailure("the task page answered with status 500")).toBe(true);
    expect(isEnvironmentFailure("Internal Server Error on /api/tasks")).toBe(true);
  });

  it("keeps a real defect out of the environmental bucket", () => {
    expect(isEnvironmentFailure("the total is 0 where the coupon should have deducted 5")).toBe(false);
    expect(isEnvironmentFailure("the delete button is missing from the row")).toBe(false);
  });
});

describe("splitScenarioFailures", () => {
  const reasons = [
    { scenarioId: "S-1-a", reason: "connection refused on http://localhost:5173" },
    { scenarioId: "S-1-b", reason: "the row shows yesterday's total" },
  ];

  it("separates the code-level failures from the environmental ones", () => {
    expect(splitScenarioFailures(["S-1-a", "S-1-b"], reasons)).toEqual({
      code: ["S-1-b"],
      environment: ["S-1-a"],
    });
  });

  it("counts a scenario with any code-level reason as code-level", () => {
    const mixed = [
      { scenarioId: "S-1-a", reason: "connection refused" },
      { scenarioId: "S-1-a", reason: "the total is wrong" },
    ];
    expect(splitScenarioFailures(["S-1-a"], mixed)).toEqual({ code: ["S-1-a"], environment: [] });
  });

  it("takes a failure with no reason as code-level rather than assuming the box", () => {
    expect(splitScenarioFailures(["S-1-c"], reasons)).toEqual({ code: ["S-1-c"], environment: [] });
  });
});
