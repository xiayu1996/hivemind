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
    // These pages read the ledger only; an overview read never reaches them.
    readOverview: () => Promise.reject(new Error("overview is not read by this page")),
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

  it("@scenario S-R237511CO-03-overview 首屏用清单约定的角色标出费用已超限和继续运行", async () => {
    const app = await createConsoleServer(dataWithAlerts(), { serveUi: false });
    try {
      const html = (await app.inject({ method: "GET", url: "/" })).body;
      // The DoD declares these three as a text node and a status region. The
      // snapshot publishes a text run as `text` only while its container has a
      // second child, so the label keeps its count and the promise keeps its
      // costs link; the over-limit word is an explicit status region.
      expect(html).toContain('<span class="metric-name">费用已超限</span><div class="metric-value">1</div>');
      expect(html).toContain('<div class="metric-detail"><span>工作仍会继续</span> <a href="/costs">查看超限需求</a></div>');
      expect(html).toContain('<span class="status danger" role="status">已超限</span>');
      expect(html).not.toContain("已暂停");
    } finally {
      await app.close();
    }
  });

  it("@scenario S-R237511CO-03-continue 首屏把仍有工作的超限需求标为运行中", async () => {
    const app = await createConsoleServer(dataWithAlerts(), { serveUi: false });
    try {
      const html = (await app.inject({ method: "GET", url: "/" })).body;
      // Continuing work must be readable as running, not as waiting on a
      // person to raise the limit.
      expect(html).toContain('<span class="status running" role="status">运行中</span>');
      expect(html).toContain('<span class="status danger" role="status">已超限</span>');
      expect(html).toContain('<div class="metric-detail"><span>工作仍会继续</span> <a href="/costs">查看超限需求</a></div>');
      expect(html).not.toContain("等待本人提高费用上限");
    } finally {
      await app.close();
    }
  });
});
