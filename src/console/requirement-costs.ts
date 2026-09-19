import type {
  CostCategory,
  HistoricalCostEntry,
  ProviderBillingMode,
  RequirementCostSnapshot,
} from "../persistence/requirement-cost-ledger.js";

export interface RequirementCostViewOptions {
  locale: string;
  timeZone: string;
}

export interface RequirementCostDetailRow {
  entryId: string;
  occurredAt: string;
  provider: string;
  model: string;
  billingMode: ProviderBillingMode;
  billingModeLabel: string;
  category: CostCategory;
  categoryLabel: string;
  usage: string;
  historicalUnitPrice: string | null;
  amount: string | null;
  pricingStatus: HistoricalCostEntry["pricingStatus"];
}

/** The four pricing categories as the page names them, never merged. */
export function costCategoryLabel(category: CostCategory): string {
  switch (category) {
    case "uncached_input": return "未缓存输入";
    case "output": return "输出";
    case "cache_read": return "缓存读取";
    case "cache_write": return "缓存写入";
  }
}

/** How the call was paid for, kept apart from whether it counts toward the ceiling. */
export function billingModeLabel(mode: ProviderBillingMode): string {
  return mode === "metered" ? "按量付费" : "订阅制";
}

export interface CompleteRequirementCostSummary {
  state: "complete";
  heading: string;
  total: string;
  pricingBasis: string;
  subscriptionNotice: string;
}

export interface IncompleteRequirementCostSummary {
  state: "incomplete";
  heading: string;
  knownSubtotal: string;
  missingPriceNotice: string;
}

export type RequirementCostSummary =
  | CompleteRequirementCostSummary
  | IncompleteRequirementCostSummary;

export interface RequirementCostView {
  requirementId: string;
  summary: RequirementCostSummary;
  ceilingJudgment: {
    label: string;
    amount: string;
    explanation: string;
  };
  detailHeading: string;
  details: readonly RequirementCostDetailRow[];
}

const detailFormatters = new Map<string, Intl.DateTimeFormat>();

function detailFormatter(options: RequirementCostViewOptions): Intl.DateTimeFormat {
  const key = `${options.locale}\u0000${options.timeZone}`;
  const cached = detailFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  detailFormatters.set(key, formatter);
  return formatter;
}

/** Whole token counts read as `200 万令牌` / `11 令牌`, never merged across buckets. */
function formatTokenCount(tokenCount: number): string {
  if (tokenCount >= 10_000 && tokenCount % 10_000 === 0) {
    return `${tokenCount / 10_000} 万令牌`;
  }
  return `${tokenCount} 令牌`;
}

/** Dollars are settled to the cent, whichever shape the snapshot carries. */
function formatUsd(amountUsd: string): string {
  const value = Number(amountUsd);
  return `$${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
}

function toDetailRow(
  entry: HistoricalCostEntry,
  formatter: Intl.DateTimeFormat,
): RequirementCostDetailRow {
  const priced = entry.pricingStatus === "priced";
  return {
    entryId: entry.entryId,
    occurredAt: formatter.format(new Date(entry.occurredAtMs)),
    provider: entry.provider,
    model: entry.model,
    billingMode: entry.billingMode,
    billingModeLabel: billingModeLabel(entry.billingMode),
    category: entry.category,
    categoryLabel: costCategoryLabel(entry.category),
    usage: formatTokenCount(entry.tokenCount),
    historicalUnitPrice: priced ? `$${entry.usdPerMillionTokens}/百万` : null,
    amount: priced ? formatUsd(entry.amountUsd) : null,
    pricingStatus: entry.pricingStatus,
  };
}

/**
 * Renders a requirement's whole-history cost snapshot. Both billing modes keep
 * their occurrence-time official price; the ceiling judgment stays a separate,
 * metered-only amount. An unpriced entry keeps a null price and amount, so the
 * known subtotal is never presented as a complete total.
 */
export function presentRequirementCost(
  snapshot: RequirementCostSnapshot,
  options: RequirementCostViewOptions,
): RequirementCostView {
  const total = snapshot.total;
  const summary: RequirementCostSummary = total.completeness === "complete"
    ? {
      state: "complete",
      heading: "全部轮次累计",
      total: formatUsd(total.totalUsd),
      pricingBasis: "按发生时的官方按量价格计算",
      subscriptionNotice: "订阅制使用按官方按量价格计入，不显示为免费",
    }
    : {
      state: "incomplete",
      heading: "累计费用暂不完整",
      knownSubtotal: formatUsd(total.knownSubtotalUsd),
      missingPriceNotice: `${total.missingPriceCount} 项使用缺少官方按量价格`,
    };

  const formatter = detailFormatter(options);
  return {
    requirementId: snapshot.requirementId,
    summary,
    ceilingJudgment: {
      label: "用于上限判断",
      amount: formatUsd(snapshot.ceilingJudgment.amountUsd),
      explanation: "仅统计按量付费调用",
    },
    detailHeading: "供应商与模型明细",
    details: snapshot.entries.map((entry) => toDetailRow(entry, formatter)),
  };
}
