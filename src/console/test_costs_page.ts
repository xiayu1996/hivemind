import { describe, expect, it } from "vitest";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import {
  listDailyCostTimeZones,
  type DailyCostReadResult,
  type DailyCostSelection,
  type DailyCostSnapshot,
} from "./daily-costs.js";
import { loadCostsPage, renderCostsRoute } from "./costs-page.js";

const zones = listDailyCostTimeZones();

const shanghai = { timeZone: "Asia/Shanghai", startDate: "2025-06-20", endDate: "2025-06-21" };

function snapshotOf(selection: DailyCostSelection, days: DailyCostSnapshot["days"], pendingBilling: DailyCostSnapshot["pendingBilling"] = "settled"): DailyCostSnapshot {
  return {
    selection,
    days,
    totalUsd: Math.round(days.reduce((sum, day) => sum + day.costUsd, 0) * 100) / 100,
    pendingBilling,
    generatedAt: 1_700_000_000_000,
  };
}

function okSnapshot(): DailyCostReadResult {
  return {
    kind: "ok",
    snapshot: snapshotOf(shanghai, [
      { date: "2025-06-20", costUsd: 1.2, count: 1 },
      { date: "2025-06-21", costUsd: 2.3, count: 1 },
    ]),
  };
}

describe("costs page is reachable and shows the amount for each state", () => {
  it("@scenario S-R237511CO-01-shanghai 费用分析页按上海自然日显示 06-20 $1.20 与 06-21 $2.30", async () => {
    const seen: DailyCostSelection[] = [];
    const html = await renderCostsRoute(
      { timeZone: "Asia/Shanghai", range: "2025-06-20|2025-06-21" },
      zones,
      (selection) => {
        seen.push(selection);
        return Promise.resolve(okSnapshot());
      },
    );

    expect(seen).toEqual([shanghai]);
    expect(html).toContain("<h1>费用分析</h1>");
    expect(html).toContain(">Asia/Shanghai (UTC+8)</option>");
    expect(html).toContain('<h2 id="daily-title">每日费用</h2>按 Asia/Shanghai 自然日 · 美元');
    expect(html).toContain('<strong class="money">$1.20</strong>');
    expect(html).toContain('<strong class="money">$2.30</strong>');
    // The out-of-range day is never part of the selected range's page.
    expect(html).not.toContain("$9.00");
  });

  it("@scenario S-R237511CO-01-utc 切到 UTC 后两笔费用合并到 06-20 $3.50", async () => {
    const html = await renderCostsRoute(
      { timeZone: "UTC", range: "2025-06-20|2025-06-21" },
      zones,
      (selection) => Promise.resolve({
        kind: "ok",
        snapshot: snapshotOf(selection, [{ date: "2025-06-20", costUsd: 3.5, count: 2 }]),
      }),
    );

    expect(html).toContain('<option value="UTC" selected>UTC (UTC+0)</option>');
    expect(html).toContain('<h2 id="daily-title">每日费用</h2>按 UTC 自然日 · 美元');
    expect(html).toContain('<strong class="money">$3.50</strong>');
    expect(html).not.toContain('data-date="2025-06-21"');
    expect(html).not.toContain('$2.30');
  });

  it("@scenario S-R237511CO-01-dst 调钟当天仍归为一个自然日并显示 $5.00", async () => {
    const html = await renderCostsRoute(
      { timeZone: "America/New_York", range: "2025-03-09|2025-03-09" },
      zones,
      (read) => Promise.resolve({
        kind: "ok",
        snapshot: snapshotOf(read, [{ date: "2025-03-09", costUsd: 5, count: 2 }]),
      }),
    );

    expect(html).toContain('<option value="America/New_York" selected>');
    expect(html).toContain('<h2 id="daily-title">每日费用</h2>按 America/New_York 自然日 · 美元');
    expect(html).toContain('<strong class="money">$5.00</strong>');
  });

  it("@scenario S-R237511CO-01-empty 所选范围没有费用时给出下一步而不是零金额日期", async () => {
    const html = await renderCostsRoute(
      { timeZone: "Asia/Shanghai", range: "2025-06-24|2025-06-25" },
      zones,
      (selection) => Promise.resolve({ kind: "ok", snapshot: snapshotOf(selection, []) }),
    );

    expect(html).toContain("<h1>费用分析</h1>");
    expect(html).toContain("<h2>所选范围还没有费用</h2>");
    expect(html).toContain("调整日期或需求范围");
    expect(html).toContain("<button type=\"submit\">调整筛选条件</button>");
    expect(html).not.toContain("$0.00");
  });

  it("@scenario S-R237511CO-01-loading 读取未返回时说明正在按所选时区汇总而不是零费用", async () => {
    let reads = 0;
    const html = await renderCostsRoute(
      { state: "loading", timeZone: "Asia/Shanghai" },
      zones,
      () => {
        reads += 1;
        return Promise.resolve(okSnapshot());
      },
    );

    expect(reads).toBe(0);
    expect(html).toContain("<h2>正在汇总费用</h2>");
    expect(html).toContain("正在按 Asia/Shanghai 自然日汇总历史使用、价格版本和美元金额，请稍候。");
    expect(html).not.toContain("所选范围还没有费用");
  });

  it("@scenario S-R237511CO-01-error 读取失败后保留所选范围并可重新读取", async () => {
    const html = await renderCostsRoute(
      { state: "error", timeZone: "Asia/Shanghai", range: "2025-06-20|2025-06-21" },
      zones,
      () => Promise.resolve({ kind: "failed", message: "ledger unavailable" }),
    );

    expect(html).toContain("<h2>无法读取费用记录</h2>");
    expect(html).toContain("所选范围的使用与价格记录没有载入。");
    expect(html).toContain("<button type=\"submit\">重新读取</button>");
    expect(html).toContain('<input type="hidden" name="timeZone" value="Asia/Shanghai">');
    expect(html).not.toContain("刚刚更新");
    expect(html).not.toContain("$3.50");
  });

  it("@scenario S-R237511CO-01-error 读取失败的结果落在错误的页面上而不是过期金额", async () => {
    const view = await loadCostsPage(
      { timeZone: "Asia/Shanghai", range: "2025-06-20|2025-06-21" },
      zones,
      () => Promise.resolve({ kind: "failed", message: "ledger unavailable" }),
    );

    expect(view.state).toBe("error");
    expect(view.selection).toEqual(shanghai);
    expect(view.snapshot).toBeUndefined();
  });

  it("@scenario S-R237511CO-01-waiting 等待最新计费时保留已有历史金额", async () => {
    const html = await renderCostsRoute(
      { state: "waiting", timeZone: "Asia/Shanghai", range: "2025-06-20|2025-06-21" },
      zones,
      (selection) => Promise.resolve({
        kind: "ok",
        snapshot: snapshotOf(selection, [{ date: "2025-06-20", costUsd: 3.5, count: 1 }], "pending_latest_usage"),
      }),
    );

    expect(html).toContain("<h2>正在等待最新使用完成计费</h2>");
    expect(html).toContain("页面会自动刷新，已有历史金额保持不变。");
    expect(html).toContain("查看当前轮");
    expect(html).toContain('<strong class="money">$3.50</strong>');
    expect(html).not.toContain("所选范围还没有费用");
  });

  it("@scenario S-R237511CO-01-waiting 最近一次使用未计费时页面进入等待状态", async () => {
    const view = await loadCostsPage(
      { timeZone: "Asia/Shanghai", range: "2025-06-20|2025-06-21" },
      zones,
      (selection) => Promise.resolve({
        kind: "ok",
        snapshot: snapshotOf(selection, [{ date: "2025-06-20", costUsd: 3.5, count: 1 }], "pending_latest_usage"),
      }),
    );

    expect(view.state).toBe("waiting");
    expect(view.snapshot?.totalUsd).toBe(3.5);
  });

  it("@scenario S-R237511CO-01-mobile 手机上每个日期与金额成对且底部费用导航可见", async () => {
    const html = await renderCostsRoute(
      { timeZone: "Asia/Shanghai", range: "2025-06-20|2025-06-21" },
      zones,
      () => Promise.resolve(okSnapshot()),
    );

    expect(html).toContain('<nav class="mobile-nav" aria-label="手机导航">');
    expect(html).toContain('href="/costs" aria-current="page">费用</a>');
    expect(html).toContain('data-date="2025-06-20"');
    expect(html).toContain('data-date="2025-06-21"');
    const firstRow = html.slice(html.indexOf('data-date="2025-06-20"'), html.indexOf('data-date="2025-06-21"'));
    expect(firstRow).toContain("06-20");
    expect(firstRow).toContain("$1.20");
  });

  it("@scenario S-R237511CO-03-nodaily 每日范围金额作为正文出现且页面不提供每日上限", async () => {
    const html = await renderCostsRoute(
      { timeZone: "Asia/Shanghai", range: "2025-06-20|2025-06-20" },
      zones,
      (selection) => Promise.resolve({
        kind: "ok",
        snapshot: snapshotOf(selection, [{ date: "2025-06-20", costUsd: 20, count: 1 }]),
      }),
    );

    // The DoD names the day total as a text node: a block container renders as
    // `generic`, so the range total is an inline text node under the selected
    // zone. Daily money stays an analysis figure; no daily ceiling exists.
    expect(html).toContain("<h1>费用分析</h1>");
    expect(html).toContain('<h2 id="daily-title">每日费用</h2>');
    expect(html).toContain("按 Asia/Shanghai 自然日");
    expect(html).toContain("<span class=\"metric-value\">$20.00</span>");
    expect(html).not.toContain("每日总费用上限");
    expect(html).not.toContain("今日已超限");
    expect(html).not.toContain("已暂停");
  });

  it("serves the costs page from a console that has no built bundle", async () => {
    const data: ConsoleDataSource = {
      nodes: async () => [],
      tasks: async () => [],
      costs: async () => [],
      config: async () => [],
      stats: async () => ({}),
      providers: async () => [],
      queue: async () => ({}),
      dailyCostTimeZones: async () => zones,
      dailyCosts: async (selection) => ({
        kind: "ok",
        snapshot: snapshotOf(selection, [
          { date: "2025-06-20", costUsd: 1.2, count: 1 },
          { date: "2025-06-21", costUsd: 2.3, count: 1 },
        ]),
      }),
    };
    const app = await createConsoleServer(data, { serveUi: false });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/costs?timeZone=Asia/Shanghai&range=2025-06-20%7C2025-06-21",
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("<h1>费用分析</h1>");
      expect(response.body).toContain("$1.20");
      expect(response.body).toContain("$2.30");
    } finally {
      await app.close();
    }
  });
});
