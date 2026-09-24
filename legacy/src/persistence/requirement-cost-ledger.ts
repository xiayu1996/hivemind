import type { Client, InValue, Row } from "@libsql/client";

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

/** The four buckets are presented and stored in this fixed order. */
const CATEGORY_ORDER: readonly CostCategory[] = [
  "uncached_input",
  "output",
  "cache_read",
  "cache_write",
];

const UNPRICED_AT_OCCURRENCE = "official_price_unavailable_at_occurrence" as const;

function tokenCountFor(usage: CategorizedTokenUsage, category: CostCategory): number {
  switch (category) {
    case "uncached_input":
      return usage.uncachedInput;
    case "output":
      return usage.output;
    case "cache_read":
      return usage.cacheRead;
    case "cache_write":
      return usage.cacheWrite;
  }
}

function requireTokenCount(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`usage.${label} must be a non-negative integer token count`);
  }
  return value;
}

function validateUsage(usage: CategorizedTokenUsage): void {
  requireTokenCount(usage.uncachedInput, "uncachedInput");
  requireTokenCount(usage.output, "output");
  requireTokenCount(usage.cacheRead, "cacheRead");
  requireTokenCount(usage.cacheWrite, "cacheWrite");
}

interface Decimal {
  digits: bigint;
  scale: number;
}

function parseDecimal(value: string): Decimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`not a decimal amount: ${value}`);
  const [, sign, whole, fraction = ""] = match;
  return { digits: BigInt(`${sign}${whole}${fraction}`), scale: fraction.length };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Rescales a non-negative decimal digit string to `targetScale`, rounding half up. */
function rescale(digits: bigint, scale: number, targetScale: number): bigint {
  if (scale === targetScale) return digits;
  if (scale < targetScale) return digits * powerOfTen(targetScale - scale);
  const divisor = powerOfTen(scale - targetScale);
  const quotient = digits / divisor;
  const remainder = digits % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

/** Cents is the settled unit: two decimal places, summed exactly as integers. */
function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${negative ? "-" : ""}${whole}.${String(fraction).padStart(2, "0")}`;
}

function centsOf(amountUsd: string): bigint {
  const { digits, scale } = parseDecimal(amountUsd);
  return rescale(digits, scale, 2);
}

/** tokens * (usd per million tokens), settled to cents. */
function amountUsdFor(tokenCount: number, usdPerMillionTokens: string): string {
  const { digits, scale } = parseDecimal(usdPerMillionTokens);
  // Dividing by a million adds six decimal places to the price's own scale.
  return formatCents(rescale(BigInt(tokenCount) * digits, scale + 6, 2));
}

function toEntry(row: Row): HistoricalCostEntry {
  const base = {
    entryId: String(row.id),
    usageEventId: String(row.usage_event_id),
    requirementId: String(row.requirement_id),
    workItemId: String(row.work_item_id),
    roundId: String(row.round_id),
    occurredAtMs: Number(row.occurred_at_ms),
    provider: String(row.provider),
    model: String(row.model_id),
    billingMode: String(row.billing_mode) as ProviderBillingMode,
    category: String(row.category) as CostCategory,
    tokenCount: Number(row.token_count),
  };
  if (String(row.pricing_status) === "priced") {
    return {
      ...base,
      pricingStatus: "priced",
      priceVersionId: String(row.price_version_id),
      usdPerMillionTokens: String(row.usd_per_million_tokens),
      amountUsd: String(row.amount_usd),
      priceSourceReference: String(row.price_source_reference),
    };
  }
  return {
    ...base,
    pricingStatus: "unpriced",
    reason: UNPRICED_AT_OCCURRENCE,
  };
}

/**
 * Records one provider call's categorized usage against a requirement. Price
 * resolution happens entirely before the single insert batch, so a catalog
 * failure leaves no half-priced record behind.
 */
export class LibsqlHistoricalCostLedger implements HistoricalCostLedger {
  constructor(
    private readonly client: Client,
    private readonly catalog: OfficialPriceCatalog,
    private readonly now: () => number = Date.now,
  ) {}

  async recordUsage(input: HistoricalUsageCostInput): Promise<readonly HistoricalCostEntry[]> {
    validateUsage(input.usage);
    const persisted = await this.readByUsageEvent(input.usageEventId);
    if (persisted.length > 0) return persisted;

    const inserts: { sql: string; args: InValue[] }[] = [];
    for (const category of CATEGORY_ORDER) {
      const tokenCount = tokenCountFor(input.usage, category);
      if (tokenCount === 0) continue;
      const price = await this.catalog.findOfficialUnitPrice({
        provider: input.provider,
        model: input.model,
        category,
        occurredAtMs: input.occurredAtMs,
      });
      const priced = price === null
        ? {
          priceVersionId: null,
          usdPerMillionTokens: null,
          amountUsd: null,
          priceSourceReference: null,
          unpricedReason: UNPRICED_AT_OCCURRENCE,
          pricingStatus: "unpriced",
        }
        : {
          priceVersionId: price.priceVersionId,
          usdPerMillionTokens: price.usdPerMillionTokens,
          amountUsd: amountUsdFor(tokenCount, price.usdPerMillionTokens),
          priceSourceReference: price.sourceReference,
          unpricedReason: null,
          pricingStatus: "priced",
        };
      inserts.push({
        sql: `INSERT INTO requirement_cost_entries (
                usage_event_id, requirement_id, work_item_id, round_id, occurred_at_ms,
                provider, model_id, billing_mode, category, token_count, pricing_status,
                price_version_id, usd_per_million_tokens, amount_usd, price_source_reference,
                unpriced_reason, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          input.usageEventId,
          input.requirementId,
          input.workItemId,
          input.roundId,
          input.occurredAtMs,
          input.provider,
          input.model,
          input.billingMode,
          category,
          tokenCount,
          priced.pricingStatus,
          priced.priceVersionId,
          priced.usdPerMillionTokens,
          priced.amountUsd,
          priced.priceSourceReference,
          priced.unpricedReason,
          this.now(),
        ],
      });
    }
    if (inserts.length === 0) return [];

    try {
      await this.client.batch(inserts, "write");
    } catch (cause) {
      // A concurrent writer won the (usageEventId, category) race; its rows are
      // the record, and they must not be repriced.
      const existing = await this.readByUsageEvent(input.usageEventId);
      if (existing.length > 0) return existing;
      throw cause;
    }
    return this.readByUsageEvent(input.usageEventId);
  }

  private async readByUsageEvent(usageEventId: string): Promise<readonly HistoricalCostEntry[]> {
    const result = await this.client.execute({
      sql: "SELECT * FROM requirement_cost_entries WHERE usage_event_id = ? ORDER BY id",
      args: [usageEventId],
    });
    return result.rows.map(toEntry);
  }
}

/** Reads a requirement's whole history, independent of any selected round. */
export class LibsqlRequirementCostReadPort implements RequirementCostReadPort {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  async readRequirementCost(requirementId: string): Promise<RequirementCostSnapshot> {
    const result = await this.client.execute({
      sql: `SELECT * FROM requirement_cost_entries
            WHERE requirement_id = ?
            ORDER BY occurred_at_ms, id`,
      args: [requirementId],
    });
    const entries = result.rows.map(toEntry);

    let pricedCents = 0n;
    let meteredCents = 0n;
    let missingPriceCount = 0;
    for (const entry of entries) {
      if (entry.pricingStatus === "priced") {
        const cents = centsOf(entry.amountUsd);
        pricedCents += cents;
        if (entry.billingMode === "metered") meteredCents += cents;
      } else {
        missingPriceCount += 1;
      }
    }

    const total: RequirementCostTotal = missingPriceCount > 0
      ? { completeness: "incomplete", knownSubtotalUsd: formatCents(pricedCents), missingPriceCount }
      : { completeness: "complete", totalUsd: formatCents(pricedCents) };

    return {
      requirementId,
      calculatedAtMs: this.now(),
      total,
      ceilingJudgment: { basis: "metered_only", amountUsd: formatCents(meteredCents) },
      entries,
    };
  }
}
