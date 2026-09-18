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
  category: CostCategory;
  usage: string;
  historicalUnitPrice: string | null;
  amount: string | null;
  pricingStatus: HistoricalCostEntry["pricingStatus"];
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

export declare function presentRequirementCost(
  snapshot: RequirementCostSnapshot,
  options: RequirementCostViewOptions,
): RequirementCostView;
