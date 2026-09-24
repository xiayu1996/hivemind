import { describe, expect, it } from "vitest";
import * as costPresentationRuntime from "./requirement-costs.js";
import type {
  HistoricalCostEntry,
  RequirementCostSnapshot,
} from "../persistence/requirement-cost-ledger.js";
import type {
  RequirementCostView,
  RequirementCostViewOptions,
} from "./requirement-costs.js";

type PresentRequirementCost = (
  snapshot: RequirementCostSnapshot,
  options: RequirementCostViewOptions,
) => RequirementCostView;

type RuntimeExports = {
  presentRequirementCost?: PresentRequirementCost;
};

const runtime = costPresentationRuntime as RuntimeExports;
const OCCURRED_AT = Date.parse("2025-06-20T12:00:00Z");
const options = { locale: "zh-CN", timeZone: "Asia/Shanghai" };

function presenter(): PresentRequirementCost {
  expect(runtime.presentRequirementCost, "presentRequirementCost export").toBeTypeOf("function");
  return runtime.presentRequirementCost as PresentRequirementCost;
}

function pricedEntry(
  entryId: string,
  overrides: Partial<HistoricalCostEntry> = {},
): HistoricalCostEntry {
  return {
    entryId,
    usageEventId: `usage-${entryId}`,
    requirementId: "R-main",
    workItemId: "S-old",
    roundId: "round-1",
    occurredAtMs: OCCURRED_AT,
    provider: "metered-provider",
    model: "model-a",
    billingMode: "metered",
    category: "output",
    tokenCount: 1_000_000,
    pricingStatus: "priced",
    priceVersionId: "price-v1",
    usdPerMillionTokens: "2.00",
    amountUsd: "2.00",
    priceSourceReference: "https://prices.example/price-v1",
    ...overrides,
  } as HistoricalCostEntry;
}

function completeSnapshot(
  entries: readonly HistoricalCostEntry[],
  totalUsd = "13.05",
  ceilingUsd = "4.35",
): RequirementCostSnapshot {
  return {
    requirementId: "R-main",
    calculatedAtMs: OCCURRED_AT + 10,
    total: { completeness: "complete", totalUsd },
    ceilingJudgment: { basis: "metered_only", amountUsd: ceilingUsd },
    entries,
  };
}

describe("requirement cost presentation", () => {
  it("@scenario S-R237511CO-02-breakdown 四种计价分类逐行显示付费方式、用量、当时单价和金额", () => {
    const snapshot = completeSnapshot([
      pricedEntry("entry-1", {
        category: "uncached_input",
        tokenCount: 2_000_000,
        usdPerMillionTokens: "1.25",
        amountUsd: "2.50",
      }),
      pricedEntry("entry-2", {
        category: "output",
        tokenCount: 1_000_000,
        usdPerMillionTokens: "2.00",
        amountUsd: "2.00",
      }),
      pricedEntry("entry-3", {
        provider: "subscription-provider",
        model: "model-b",
        billingMode: "subscription",
        category: "cache_read",
        tokenCount: 1_000_000,
        usdPerMillionTokens: "0.20",
        amountUsd: "0.20",
      }),
      pricedEntry("entry-4", {
        provider: "subscription-provider",
        model: "model-b",
        billingMode: "subscription",
        category: "cache_write",
        tokenCount: 500_000,
        usdPerMillionTokens: "1.00",
        amountUsd: "0.50",
      }),
    ], "5.20", "4.50");

    const view = presenter()(snapshot, options);

    expect(view.detailHeading).toBe("供应商与模型明细");
    expect(view.details).toHaveLength(4);
    expect(view.details.map((row) => [
      row.billingMode,
      row.category,
      row.usage,
      row.historicalUnitPrice,
      row.amount,
    ])).toEqual([
      ["metered", "uncached_input", "200 万令牌", "$1.25/百万", "$2.50"],
      ["metered", "output", "100 万令牌", "$2.00/百万", "$2.00"],
      ["subscription", "cache_read", "100 万令牌", "$0.20/百万", "$0.20"],
      ["subscription", "cache_write", "50 万令牌", "$1.00/百万", "$0.50"],
    ]);
    expect(view.details.every((row) => row.occurredAt.includes("2025"))).toBe(true);
  });

  it("@scenario S-R237511CO-02-breakdown 相同供应商和模型的分类不会合并成单一用量或只有合计金额", () => {
    const entries = [
      pricedEntry("entry-1", { category: "uncached_input", tokenCount: 11, amountUsd: "0.01" }),
      pricedEntry("entry-2", { category: "output", tokenCount: 7, amountUsd: "0.02" }),
      pricedEntry("entry-3", { category: "cache_read", tokenCount: 3, amountUsd: "0.03" }),
      pricedEntry("entry-4", { category: "cache_write", tokenCount: 2, amountUsd: "0.04" }),
    ];

    const view = presenter()(completeSnapshot(entries, "0.10", "0.10"), options);

    expect(view.details.map((row) => row.entryId)).toEqual(["entry-1", "entry-2", "entry-3", "entry-4"]);
    expect(view.details.map((row) => row.category)).toEqual([
      "uncached_input",
      "output",
      "cache_read",
      "cache_write",
    ]);
    expect(view.details.map((row) => row.usage)).toEqual(["11 令牌", "7 令牌", "3 令牌", "2 令牌"]);
  });

  it("@scenario S-R237511CO-02-frozen 调价前后的明细分别展示固化单价且累计为两笔金额之和", () => {
    const view = presenter()(completeSnapshot([
      pricedEntry("old-entry", {
        occurredAtMs: OCCURRED_AT,
        priceVersionId: "price-v1",
        usdPerMillionTokens: "1.00",
        amountUsd: "1.00",
      }),
      pricedEntry("new-entry", {
        occurredAtMs: Date.parse("2025-07-02T12:00:00Z"),
        priceVersionId: "price-v2",
        usdPerMillionTokens: "2.00",
        amountUsd: "2.00",
      }),
    ], "3.00", "3.00"), options);

    expect(view.summary).toMatchObject({ state: "complete", total: "$3.00" });
    expect(view.details.map((row) => [row.entryId, row.historicalUnitPrice, row.amount])).toEqual([
      ["old-entry", "$1.00/百万", "$1.00"],
      ["new-entry", "$2.00/百万", "$2.00"],
    ]);
  });

  it("@scenario S-R237511CO-02-frozen 明细顺序变化不允许用新价覆盖旧明细金额", () => {
    const oldEntry = pricedEntry("old-entry", {
      priceVersionId: "price-v1",
      usdPerMillionTokens: "1.00",
      amountUsd: "1.00",
    });
    const newEntry = pricedEntry("new-entry", {
      occurredAtMs: Date.parse("2025-07-02T12:00:00Z"),
      priceVersionId: "price-v2",
      usdPerMillionTokens: "2.00",
      amountUsd: "2.00",
    });

    const view = presenter()(completeSnapshot([newEntry, oldEntry], "3.00", "3.00"), options);

    expect(view.details.find((row) => row.entryId === "old-entry")).toMatchObject({
      historicalUnitPrice: "$1.00/百万",
      amount: "$1.00",
    });
    expect(view.details.find((row) => row.entryId === "new-entry")).toMatchObject({
      historicalUnitPrice: "$2.00/百万",
      amount: "$2.00",
    });
  });

  it("@scenario S-R237511CO-02-total 累计费用写明全部轮次、历史官方价格口径和独立上限金额", () => {
    const view = presenter()(completeSnapshot([
      pricedEntry("metered", { amountUsd: "4.35", usdPerMillionTokens: "4.35" }),
      pricedEntry("subscription-history", {
        provider: "subscription-provider",
        billingMode: "subscription",
        amountUsd: "6.70",
        usdPerMillionTokens: "6.70",
      }),
      pricedEntry("subscription-current", {
        workItemId: "S-current",
        roundId: "round-current",
        provider: "subscription-provider",
        billingMode: "subscription",
        amountUsd: "2.00",
      }),
    ]), options);

    expect(view.summary).toEqual({
      state: "complete",
      heading: "全部轮次累计",
      total: "$13.05",
      pricingBasis: "按发生时的官方按量价格计算",
      subscriptionNotice: "订阅制使用按官方按量价格计入，不显示为免费",
    });
    expect(view.ceilingJudgment).toEqual({
      label: "用于上限判断",
      amount: "$4.35",
      explanation: "仅统计按量付费调用",
    });
  });

  it("@scenario S-R237511CO-02-total 订阅制金额不能显示为免费或混入上限判断金额", () => {
    const view = presenter()(completeSnapshot([
      pricedEntry("metered", { amountUsd: "4.35" }),
      pricedEntry("subscription", {
        provider: "subscription-provider",
        billingMode: "subscription",
        amountUsd: "8.70",
      }),
    ]), options);

    expect(view.summary.state).toBe("complete");
    if (view.summary.state !== "complete") return;
    expect(view.summary.total).toBe("$13.05");
    expect(view.summary.subscriptionNotice).not.toContain("$0.00");
    expect(view.ceilingJudgment.amount).toBe("$4.35");
    expect(view.ceilingJudgment.amount).not.toBe(view.summary.total);
  });

  it("@scenario S-R237511CO-02-unpriced 缺价时显示未完整、已知小计和可定位的缺价项目", () => {
    const missingEntry: HistoricalCostEntry = {
      entryId: "missing-entry",
      usageEventId: "missing-usage",
      requirementId: "R-main",
      workItemId: "S-current",
      roundId: "round-current",
      occurredAtMs: OCCURRED_AT,
      provider: "subscription-provider",
      model: "missing-model",
      billingMode: "subscription",
      category: "cache_read",
      tokenCount: 1_000_000,
      pricingStatus: "unpriced",
      reason: "official_price_unavailable_at_occurrence",
    };
    const snapshot: RequirementCostSnapshot = {
      requirementId: "R-main",
      calculatedAtMs: OCCURRED_AT + 10,
      total: { completeness: "incomplete", knownSubtotalUsd: "3.00", missingPriceCount: 1 },
      ceilingJudgment: { basis: "metered_only", amountUsd: "3.00" },
      entries: [
        pricedEntry("known-entry", { amountUsd: "3.00", usdPerMillionTokens: "3.00" }),
        missingEntry,
      ],
    };

    const view = presenter()(snapshot, options);

    expect(view.summary).toEqual({
      state: "incomplete",
      heading: "累计费用暂不完整",
      knownSubtotal: "$3.00",
      missingPriceNotice: "1 项使用缺少官方按量价格",
    });
    expect(view.details.find((row) => row.entryId === "missing-entry")).toMatchObject({
      provider: "subscription-provider",
      model: "missing-model",
      category: "cache_read",
      pricingStatus: "unpriced",
      historicalUnitPrice: null,
      amount: null,
    });
    expect(view.details.find((row) => row.entryId === "missing-entry")?.occurredAt).toContain("2025");
  });

  it("@scenario S-R237511CO-02-unpriced 缺价使用不显示零美元且已知小计不冒充完整累计", () => {
    const snapshot: RequirementCostSnapshot = {
      requirementId: "R-main",
      calculatedAtMs: OCCURRED_AT + 10,
      total: { completeness: "incomplete", knownSubtotalUsd: "3.00", missingPriceCount: 1 },
      ceilingJudgment: { basis: "metered_only", amountUsd: "3.00" },
      entries: [{
        entryId: "missing-entry",
        usageEventId: "missing-usage",
        requirementId: "R-main",
        workItemId: "S-current",
        roundId: "round-current",
        occurredAtMs: OCCURRED_AT,
        provider: "subscription-provider",
        model: "missing-model",
        billingMode: "subscription",
        category: "cache_read",
        tokenCount: 1_000_000,
        pricingStatus: "unpriced",
        reason: "official_price_unavailable_at_occurrence",
      }],
    };

    const view = presenter()(snapshot, options);

    expect(view.summary.state).toBe("incomplete");
    expect(view.details[0]).toMatchObject({ historicalUnitPrice: null, amount: null });
    expect(JSON.stringify(view.details[0])).not.toContain("$0.00");
    expect(JSON.stringify(view.summary)).not.toContain("全部轮次累计");
  });
});
