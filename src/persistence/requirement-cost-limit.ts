import type {
  RequirementCostSnapshot,
  RequirementCostTotal,
} from "./requirement-cost-ledger.js";

/** Exact USD cents. Constructors must reject non-safe or negative integers. */
export type UsdCents = number & { readonly usdCents: unique symbol };

export interface RequirementCostLimitRecord {
  requirementId: string;
  limitUsdCents: UsdCents;
  version: number;
  updatedAtMs: number;
  updatedBy: string;
}

export interface SaveRequirementCostLimitInput {
  requirementId: string;
  limitUsdCents: UsdCents;
  expectedVersion: number | null;
  updatedAtMs: number;
  updatedBy: string;
}

export type SaveRequirementCostLimitResult =
  | { kind: "saved"; record: RequirementCostLimitRecord }
  | { kind: "requirement_not_found" }
  | { kind: "version_conflict"; current: RequirementCostLimitRecord | null };

export interface RequirementCostLimitStore {
  /** Reads null when the requirement exists without a configured limit. */
  readRequirementCostLimit(requirementId: string): Promise<RequirementCostLimitRecord | null>;

  /**
   * Creates or replaces one requirement's limit with optimistic concurrency.
   * A null expected version only matches an absent row. Different requirement
   * ids do not contend; concurrent writes to one id have one winner.
   */
  saveRequirementCostLimit(input: SaveRequirementCostLimitInput): Promise<SaveRequirementCostLimitResult>;
}

export type RequirementCostLimitAssessment =
  | { status: "not_set" }
  | {
    status: "within_limit";
    totalUsdCents: UsdCents;
    limitUsdCents: UsdCents;
  }
  | {
    status: "over_limit";
    totalUsdCents: UsdCents;
    limitUsdCents: UsdCents;
    excessUsdCents: UsdCents;
  }
  | {
    status: "over_limit_at_least";
    knownSubtotalUsdCents: UsdCents;
    limitUsdCents: UsdCents;
    minimumExcessUsdCents: UsdCents;
    missingPriceCount: number;
  }
  | {
    status: "indeterminate";
    knownSubtotalUsdCents: UsdCents;
    limitUsdCents: UsdCents;
    missingPriceCount: number;
  };

export interface RequirementCostWithLimitSnapshot {
  cost: RequirementCostSnapshot;
  limit: RequirementCostLimitRecord | null;
  assessment: RequirementCostLimitAssessment;
}

export interface OverLimitRequirementSnapshot {
  requirementId: string;
  title: string;
  requirementState: string;
  assessment: Extract<
    RequirementCostLimitAssessment,
    { status: "over_limit" | "over_limit_at_least" }
  >;
}

export interface RequirementCostLimitReadPort {
  /** Returns null only when the requirement itself does not exist. */
  readRequirementCostWithLimit(requirementId: string): Promise<RequirementCostWithLimitSnapshot | null>;

  /** Reads every definitely over-limit requirement for the overview projection. */
  listOverLimitRequirements(): Promise<readonly OverLimitRequirementSnapshot[]>;
}

/**
 * Compares the whole-history total, not the metered-only card ceiling amount.
 * Equality is within limit. An incomplete total can only assert over-limit when
 * its known non-negative subtotal already exceeds the configured limit.
 */
export declare function assessRequirementCostLimit(
  total: RequirementCostTotal,
  limit: RequirementCostLimitRecord | null,
): RequirementCostLimitAssessment;
