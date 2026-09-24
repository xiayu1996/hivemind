import { describe, expect, it, vi } from "vitest";
import { dispatchableStories, planStoryExecution } from "../orchestrator/scheduler.js";
import * as costLimitRuntime from "../persistence/requirement-cost-limit.js";
import type {
  OverLimitRequirementSnapshot,
  RequirementCostLimitAssessment,
  RequirementCostLimitReadPort,
  RequirementCostLimitRecord,
  UsdCents,
} from "../persistence/requirement-cost-limit.js";
import type { RequirementCostTotal } from "../persistence/requirement-cost-ledger.js";
import * as overviewRuntime from "./overview-cost-alerts.js";
import type { OverviewCostAlertsView } from "./overview-cost-alerts.js";

type LoadOverviewCostAlerts = (
  reader: RequirementCostLimitReadPort,
) => Promise<OverviewCostAlertsView>;

type AssessRequirementCostLimit = (
  total: RequirementCostTotal,
  limit: RequirementCostLimitRecord | null,
) => RequirementCostLimitAssessment;

type OverviewRuntimeExports = {
  loadOverviewCostAlerts?: LoadOverviewCostAlerts;
};

type CostLimitRuntimeExports = {
  assessRequirementCostLimit?: AssessRequirementCostLimit;
};

const overview = overviewRuntime as OverviewRuntimeExports;
const costLimit = costLimitRuntime as CostLimitRuntimeExports;

function cents(value: number): UsdCents {
  return value as UsdCents;
}

function overLimitSnapshot(): OverLimitRequirementSnapshot {
  return {
    requirementId: "R-main",
    title: "持续运行的需求",
    requirementState: "EXECUTING",
    assessment: {
      status: "over_limit",
      totalUsdCents: cents(1_722),
      limitUsdCents: cents(1_500),
      excessUsdCents: cents(222),
    },
  };
}

function reader(): RequirementCostLimitReadPort {
  return {
    readRequirementCostWithLimit: vi.fn(),
    listOverLimitRequirements: vi.fn().mockResolvedValue([overLimitSnapshot()]),
  };
}

function alertLoader(): LoadOverviewCostAlerts {
  expect(overview.loadOverviewCostAlerts, "loadOverviewCostAlerts export").toBeTypeOf("function");
  return overview.loadOverviewCostAlerts as LoadOverviewCostAlerts;
}

function assessor(): AssessRequirementCostLimit {
  expect(costLimit.assessRequirementCostLimit, "assessRequirementCostLimit export").toBeTypeOf("function");
  return costLimit.assessRequirementCostLimit as AssessRequirementCostLimit;
}

describe("over-limit alerts remain separate from execution", () => {
  it("@scenario S-R237511CO-03-continue 超限需求的下一轮仍进入执行计划且新增费用继续累计", async () => {
    const alerts = await alertLoader()(reader());
    const plan = planStoryExecution(dispatchableStories([
      { id: "S-next", state: "QUEUED", dependsOn: [], predictedFootprint: ["src/console"] },
    ]), []);
    const afterNextRound = assessor()(
      { completeness: "complete", totalUsd: "19.44" },
      {
        requirementId: "R-main",
        limitUsdCents: cents(1_500),
        version: 1,
        updatedAtMs: 1_700_000_000_000,
        updatedBy: "owner",
      },
    );

    expect(alerts).toMatchObject({ count: 1, heading: "费用已超限 1" });
    expect(plan).toEqual({ kind: "planned", batches: [["S-next"]] });
    expect(afterNextRound).toEqual({
      status: "over_limit",
      totalUsdCents: 1_944,
      limitUsdCents: 1_500,
      excessUsdCents: 444,
    });
  });

  it("@scenario S-R237511CO-03-continue 超限提醒不产生暂停状态或等待本人处理事项", async () => {
    const source = reader();
    const alerts = await alertLoader()(source);
    const serialized = JSON.stringify(alerts);

    expect(source.listOverLimitRequirements).toHaveBeenCalledTimes(1);
    expect(source.readRequirementCostWithLimit).not.toHaveBeenCalled();
    expect(alerts.rows).toEqual([
      {
        requirementId: "R-main",
        requirementTitle: "持续运行的需求",
        requirementState: "EXECUTING",
        status: "over_limit",
        statusText: "已超限",
        continuationText: "工作仍会继续",
        visual: {
          colorToken: "color.danger",
          surfaceToken: "color.surface-danger",
        },
      },
    ]);
    expect(serialized).not.toContain("已暂停");
    expect(serialized).not.toContain("等待本人提高费用上限");
    expect(alerts.rows[0]).not.toHaveProperty("stopReason");
    expect(alerts.rows[0]).not.toHaveProperty("humanAction");
  });
});
