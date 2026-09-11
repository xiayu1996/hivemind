import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isEnvironmentFailure, isProviderFault, splitScenarioFailures } from "./failure-classification.js";

const REASON_FIXTURE_DIR = new URL("../../fixtures/verify-reasons/", import.meta.url);

interface ReasonFixture {
  capturedFrom: { cardId: string; round: number };
  origin: "environment" | "code";
  reasons: { scenarioId: string; reason: string }[];
}

function reasonFixtures(): { name: string; fixture: ReasonFixture }[] {
  return readdirSync(REASON_FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => ({
      name,
      fixture: JSON.parse(readFileSync(new URL(name, REASON_FIXTURE_DIR), "utf8")) as ReasonFixture,
    }));
}

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

describe("reasons that describe the reviewer's own harness", () => {
  it("treats a route the Story adds being not found, or a stale page, as the environment", () => {
    expect(isEnvironmentFailure("its /api/overview request returned Route GET:/api/overview not found, so the worktree UI could not be reproduced.")).toBe(true);
    expect(isEnvironmentFailure("Browser showed the pre-existing nodes view instead of the Story's page")).toBe(true);
    expect(isEnvironmentFailure("the total is missing from the checkout page")).toBe(false);
  });
});

describe("isProviderFault", () => {
  it("names a phase the provider or the operator ended, which nobody refused for its approach", () => {
    expect(isProviderFault("OAuth refresh failed for openai-codex: token refresh failed (401)")).toBe(true);
    expect(isProviderFault("stopped by the operator: the card is being reset to DESIGN")).toBe(true);
    expect(isProviderFault("git diff --check reported trailing whitespace in src/a.ts:12")).toBe(false);
  });
});

/**
 * Every captured round is replayed by reading the directory, so a fixture
 * added later is asserted without anyone remembering to list it here.
 */
describe("captured verification rounds", () => {
  const fixtures = reasonFixtures();

  it("has rounds to replay", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { name, fixture } of fixtures) {
    it(`classifies every reason of ${name} as ${fixture.origin}`, () => {
      expect(fixture.reasons.length).toBeGreaterThan(0);
      for (const { reason } of fixture.reasons) {
        expect(isEnvironmentFailure(reason), reason).toBe(fixture.origin === "environment");
      }
    });

    it(`keeps ${name} out of the code-failure set`, () => {
      const scenarioIds = fixture.reasons.map((entry) => entry.scenarioId);
      const split = splitScenarioFailures(scenarioIds, fixture.reasons);
      const judged = fixture.origin === "environment" ? split.code : split.environment;
      expect(judged).toEqual([]);
    });
  }
});

describe("browser errors that do describe the page the Story owns", () => {
  it("does not excuse a Story defect because the browser named it", () => {
    // Chromium reports both of these, and both are the page's own doing: an
    // asset the build never emitted, and a request the page's own code blocked.
    expect(isEnvironmentFailure("the logo request failed with net::ERR_FILE_NOT_FOUND")).toBe(false);
    expect(isEnvironmentFailure("the analytics call failed with net::ERR_BLOCKED_BY_CLIENT")).toBe(false);
  });
});
