import { describe, expect, it } from "vitest";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import { loadOverviewCostAlerts } from "./overview-cost-alerts.js";
import type {
  OverLimitRequirementSnapshot,
  RequirementCostLimitReadPort,
  UsdCents,
} from "../persistence/requirement-cost-limit.js";

function cents(value: number): UsdCents {
  return value as UsdCents;
}

function overLimit(): OverLimitRequirementSnapshot {
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
    readRequirementCostWithLimit: async () => null,
    listOverLimitRequirements: async () => [overLimit()],
  };
}

function dataWithAlerts(): ConsoleDataSource {
  return {
    nodes: async () => [],
    tasks: async () => [],
    costs: async () => [],
    config: async () => [],
    stats: async () => ({}),
    providers: async () => [],
    queue: async () => ({}),
    overLimitRequirements: async () => [overLimit()],
  };
}

describe("the overview screen states a requirement cost alert without pausing it", () => {
  it("@scenario S-R237511CO-03-overview 首屏显示费用已超限计数与继续运行说明", async () => {
    const app = await createConsoleServer(dataWithAlerts(), { serveUi: false });
    try {
      const response = await app.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<h1>运行总览</h1>");
      expect(response.body).toContain("费用已超限");
      expect(response.body).toContain("持续运行的需求");
      expect(response.body).toContain("已超限");
      expect(response.body).toContain("工作仍会继续");
      expect(response.body).not.toContain("已暂停");
    } finally {
      await app.close();
    }
  });

  it("@scenario S-R237511CO-03-overview 超限需求旁显示已超限与工作仍会继续且不显示已暂停", async () => {
    const view = await loadOverviewCostAlerts(reader());

    expect(view.count).toBe(1);
    expect(view.heading).toBe("费用已超限 1");
    expect(view.rows[0]).toMatchObject({
      requirementTitle: "持续运行的需求",
      status: "over_limit",
      statusText: "已超限",
      continuationText: "工作仍会继续",
      visual: { colorToken: "color.danger", surfaceToken: "color.surface-danger" },
    });
    expect(JSON.stringify(view)).not.toContain("已暂停");
  });
});
