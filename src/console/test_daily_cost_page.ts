import { describe, expect, it } from "vitest";
import {
  formatUsd,
  loadingCostCopy,
  reduceDailyCostView,
  renderDailyCostPanel,
  renderMobileNavigation,
  type DailyCostViewSelection,
  type DailyCostViewSnapshot,
  type DailyCostViewState,
} from "../../console-ui/src/costs/contracts.js";

const shanghai: DailyCostViewSelection = {
  timeZone: "Asia/Shanghai",
  startDate: "2025-06-20",
  endDate: "2025-06-21",
};

function twoDays(): DailyCostViewSnapshot {
  return {
    selection: shanghai,
    scope: "按 Asia/Shanghai 自然日 · 美元",
    days: [
      { date: "2025-06-20", costUsd: 1.2, count: 1 },
      { date: "2025-06-21", costUsd: 2.3, count: 1 },
    ],
    totalUsd: 3.5,
    pendingBilling: "settled",
  };
}

describe("daily cost page states", () => {
  it("@scenario S-R237511CO-01-loading 读取未返回时说明正在按所选时区汇总而不是零费用", () => {
    const ready: DailyCostViewState = { status: "ready", selection: shanghai, requestId: 1, snapshot: twoDays() };

    const loading = reduceDailyCostView(ready, { type: "select", selection: shanghai, requestId: 2 });

    expect(loading.status).toBe("loading");
    if (loading.status !== "loading") return;

    const copy = loadingCostCopy(loading.selection);
    expect(copy.heading).toBe("正在汇总费用");
    expect(copy.body).toBe("正在按 Asia/Shanghai 自然日汇总历史使用、价格版本和美元金额，请稍候。");

    // An unfinished read must not carry the previous day totals as if they were
    // this range's result, and it must not read as an empty range either.
    expect(JSON.stringify(loading)).not.toContain("1.2");
    expect(JSON.stringify(loading)).not.toContain("2.3");
    expect(copy.heading).not.toContain("所选范围还没有费用");
  });

  it("@scenario S-R237511CO-01-mobile 手机上每个日期与美元金额成对且底部费用导航可见", () => {
    const panel = renderDailyCostPanel(twoDays());

    expect(panel).toContain("每日费用");
    expect(panel).toContain("按 Asia/Shanghai 自然日 · 美元");

    const rows = panel.split('<div class="bar-row" data-date=').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('data-date="2025-06-20"');
    expect(rows[0]).toContain("06-20");
    expect(rows[0]).toContain("$1.20");
    expect(rows[1]).toContain('data-date="2025-06-21"');
    expect(rows[1]).toContain("06-21");
    expect(rows[1]).toContain("$2.30");

    const nav = renderMobileNavigation();
    expect(nav).toContain('aria-label="手机导航"');
    expect(nav).toContain('href="costs.html"');
    expect(nav).toContain('aria-current="page">费用</a>');

    expect(formatUsd(2.3)).toBe("$2.30");
  });
});
