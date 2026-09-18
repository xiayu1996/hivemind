export type CostCategory = "uncached_input" | "output" | "cache_read" | "cache_write";

export type ProviderBillingMode = "metered" | "subscription";

export interface CategorizedTokenUsage {
  uncachedInput: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface HistoricalUsageCostInput {
  usageEventId: string;
  requirementId: string;
  workItemId: string;
  roundId: string;
  occurredAtMs: number;
  provider: string;
  model: string;
  billingMode: ProviderBillingMode;
  usage: CategorizedTokenUsage;
}

export interface OfficialPriceLookup {
  provider: string;
  model: string;
  category: CostCategory;
  occurredAtMs: number;
}

export interface OfficialUnitPrice {
  priceVersionId: string;
  effectiveFromMs: number;
  effectiveUntilMs: number | null;
  usdPerMillionTokens: string;
  sourceReference: string;
}

export interface OfficialPriceCatalog {
  // Effective intervals are inclusive at the start and exclusive at the end.
  findOfficialUnitPrice(lookup: OfficialPriceLookup): Promise<OfficialUnitPrice | null>;
}

interface HistoricalCostEntryBase {
  entryId: string;
  usageEventId: string;
  requirementId: string;
  workItemId: string;
  roundId: string;
  occurredAtMs: number;
  provider: string;
  model: string;
  billingMode: ProviderBillingMode;
  category: CostCategory;
  tokenCount: number;
}

export interface PricedHistoricalCostEntry extends HistoricalCostEntryBase {
  pricingStatus: "priced";
  priceVersionId: string;
  usdPerMillionTokens: string;
  amountUsd: string;
  priceSourceReference: string;
}

export interface UnpricedHistoricalCostEntry extends HistoricalCostEntryBase {
  pricingStatus: "unpriced";
  reason: "official_price_unavailable_at_occurrence";
}

export type HistoricalCostEntry = PricedHistoricalCostEntry | UnpricedHistoricalCostEntry;

export interface HistoricalCostLedger {
  // The ledger owns price resolution and insertion in one transaction. Each non-zero
  // category is inserted once under (usageEventId, category); concurrent duplicates
  // return the persisted entries without repricing them.
  recordUsage(input: HistoricalUsageCostInput): Promise<readonly HistoricalCostEntry[]>;
}

export interface CompleteRequirementCostTotal {
  completeness: "complete";
  totalUsd: string;
}

export interface IncompleteRequirementCostTotal {
  completeness: "incomplete";
  knownSubtotalUsd: string;
  missingPriceCount: number;
}

export type RequirementCostTotal = CompleteRequirementCostTotal | IncompleteRequirementCostTotal;

export interface RequirementCostCeilingAmount {
  amountUsd: string;
  basis: "metered_only";
}

export interface RequirementCostSnapshot {
  requirementId: string;
  calculatedAtMs: number;
  total: RequirementCostTotal;
  ceilingJudgment: RequirementCostCeilingAmount;
  entries: readonly HistoricalCostEntry[];
}

export interface RequirementCostReadPort {
  // Reads the requirement and every descendant work item across all rounds.
  // Entries are ordered by occurrence time and entry id for stable refreshes.
  readRequirementCost(requirementId: string): Promise<RequirementCostSnapshot>;
}
