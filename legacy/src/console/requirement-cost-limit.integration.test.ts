import { describe, expect, it, vi } from "vitest";
import { dispatchableStories, planStoryExecution } from "../orchestrator/scheduler.js";
import type {
  RequirementCostLimitAssessment,
  RequirementCostLimitReadPort,
  RequirementCostLimitRecord,
  RequirementCostWithLimitSnapshot,
  UsdCents,
} from "../persistence/requirement-cost-limit.js";
import type { RequirementCostSnapshot } from "../persistence/requirement-cost-ledger.js";
import { renderDailyCostPanel } from "../../console-ui/src/costs/contracts.js";
import * as costLimitRuntime from "./requirement-cost-limit.js";
import type { RequirementCostLimitPageView } from "./requirement-cost-limit.js";

type PresentRequirementCostLimit = (
  snapshot: RequirementCostWithLimitSnapshot,
) => RequirementCostLimitPageView;

type LoadRequirementCostLimit = (
  requirementId: string,
  reader: RequirementCostLimitReadPort,
) => Promise<RequirementCostLimitPageView | null>;

type RuntimeExports = {
  presentRequirementCostLimit?: PresentRequirementCostLimit;
  loadRequirementCostLimit?: LoadRequirementCostLimit;
};

const runtime = costLimitRuntime as RuntimeExports;

function cents(value: number): UsdCents {
  return value as UsdCents;
}

function cost(totalUsd: string): RequirementCostSnapshot {
  return {
    requirementId: "R-main",
    calculatedAtMs: 1_700_000_000_000,
    total: { completeness: "complete", totalUsd },
    ceilingJudgment: { basis: "metered_only", amountUsd: totalUsd },
    entries: [],
  };
}

function limit(limitUsdCents: number): RequirementCostLimitRecord {
  return {
    requirementId: "R-main",
    limitUsdCents: cents(limitUsdCents),
    version: 3,
    updatedAtMs: 1_700_000_000_000,
    updatedBy: "owner",
  };
}

function snapshot(
  totalUsd: string,
  configuredLimit: RequirementCostLimitRecord,
  assessment: RequirementCostLimitAssessment,
): RequirementCostWithLimitSnapshot {
  return { cost: cost(totalUsd), limit: configuredLimit, assessment };
}

function presenter(): PresentRequirementCostLimit {
  expect(runtime.presentRequirementCostLimit, "presentRequirementCostLimit export").toBeTypeOf("function");
  return runtime.presentRequirementCostLimit as PresentRequirementCostLimit;
}

function loader(): LoadRequirementCostLimit {
  expect(runtime.loadRequirementCostLimit, "loadRequirementCostLimit export").toBeTypeOf("function");
  return runtime.loadRequirementCostLimit as LoadRequirementCostLimit;
}

describe("requirement cost limit page boundary", () => {
  it("@scenario S-R237511CO-03-costinfo 同时显示全部轮次累计、需求上限和继续工作说明", () => {
    const view = presenter()(snapshot("17.22", limit(1_500), {
      status: "over_limit",
      totalUsdCents: cents(1_722),
      limitUsdCents: cents(1_500),
      excessUsdCents: cents(222),
    }));

    expect(view.metric).toMatchObject({
      cumulativeAmount: "$17.22",
      configuredLimit: "$15.00",
      status: "over_limit",
      statusText: "已超限 $2.22",
      continuationText: "工作仍会继续",
    });
    expect(`${view.metric.statusText}，${view.metric.continuationText}`).toBe("已超限 $2.22，工作仍会继续");
  });

  it("@scenario S-R237511CO-03-costinfo 超限信息使用危险色但不声称工作已暂停", () => {
    const view = presenter()(snapshot("17.22", limit(1_500), {
      status: "over_limit",
      totalUsdCents: cents(1_722),
      limitUsdCents: cents(1_500),
      excessUsdCents: cents(222),
    }));

    expect(view.metric.visual).toEqual({
      colorToken: "color.danger",
      surfaceToken: "color.surface-danger",
    });
    expect(JSON.stringify(view.metric)).not.toContain("已暂停");
  });

  it("@scenario S-R237511CO-03-nodaily 每日费用快照显示美元金额和统计时区", async () => {
    const reader: RequirementCostLimitReadPort = {
      readRequirementCostWithLimit: vi.fn().mockResolvedValue(snapshot("20.00", limit(10_000), {
        status: "within_limit",
        totalUsdCents: cents(2_000),
        limitUsdCents: cents(10_000),
      })),
      listOverLimitRequirements: vi.fn(),
    };

    const limitView = await loader()("R-main", reader);
    const dailySnapshot = {
      selection: { timeZone: "Asia/Shanghai", startDate: "2025-06-20", endDate: "2025-06-20" },
      scope: "按 Asia/Shanghai 自然日 · 美元",
      days: [{ date: "2025-06-20", costUsd: 20, count: 1 }],
      totalUsd: 20,
      pendingBilling: "settled" as const,
    };
    const dailyPanel = renderDailyCostPanel(dailySnapshot);

    expect(dailyPanel).toContain("<h2 id=\"daily-title\">每日费用</h2>");
    expect(dailyPanel).toContain("按 Asia/Shanghai 自然日 · 美元");
    expect(dailyPanel).toContain("$20.00");
    expect({
      dailyScope: dailySnapshot.scope,
      dailyRows: dailySnapshot.days,
      requirementLimit: limitView?.metric.configuredLimit,
      requirementStatus: limitView?.metric.status,
    }).toMatchInlineSnapshot(`
      {
        "dailyRows": [
          {
            "costUsd": 20,
            "count": 1,
            "date": "2025-06-20",
          },
        ],
        "dailyScope": "按 Asia/Shanghai 自然日 · 美元",
        "requirementLimit": "$100.00",
        "requirementStatus": "within_limit",
      }
    `);
  });

  it("@scenario S-R237511CO-03-nodaily 单日金额不产生每日上限、每日超限或暂停", async () => {
    const reader: RequirementCostLimitReadPort = {
      readRequirementCostWithLimit: vi.fn().mockResolvedValue(snapshot("20.00", limit(10_000), {
        status: "within_limit",
        totalUsdCents: cents(2_000),
        limitUsdCents: cents(10_000),
      })),
      listOverLimitRequirements: vi.fn(),
    };

    const view = await loader()("R-main", reader);
    const serialized = JSON.stringify(view);
    const plan = planStoryExecution(dispatchableStories([
      { id: "S-next", state: "QUEUED", dependsOn: [], predictedFootprint: ["src/console"] },
    ]), []);

    expect(serialized).not.toContain("每日总费用上限");
    expect(serialized).not.toContain("今日已超限");
    expect(serialized).not.toContain("已暂停");
    expect(view).not.toHaveProperty("dailyLimit");
    expect(plan).toEqual({ kind: "planned", batches: [["S-next"]] });
  });
});
