import type {
  RequirementCostLimitReadPort,
  RequirementCostLimitRecord,
  RequirementCostLimitStore,
  RequirementCostWithLimitSnapshot,
  SaveRequirementCostLimitResult,
  UsdCents,
} from "../persistence/requirement-cost-limit.js";

export type RequirementCostLimitInputError =
  | "required"
  | "invalid_usd"
  | "negative"
  | "more_than_two_decimal_places"
  | "outside_safe_range";

export type ParsedRequirementCostLimit =
  | { ok: true; value: UsdCents }
  | { ok: false; error: RequirementCostLimitInputError };

export interface SaveRequirementCostLimitRequest {
  requirementId: string;
  rawLimitUsd: string;
  expectedVersion: number | null;
  actor: string;
  nowMs: number;
}

export type SaveRequirementCostLimitResponse =
  | { kind: "saved"; record: RequirementCostLimitRecord }
  | { kind: "validation_failed"; error: RequirementCostLimitInputError }
  | Exclude<SaveRequirementCostLimitResult, { kind: "saved" }>;

export interface RequirementCostLimitMetricView {
  cumulativeAmount: string;
  configuredLimit: string | null;
  status: "not_set" | "within_limit" | "over_limit" | "incomplete";
  statusText: string;
  continuationText: string | null;
  visual: {
    colorToken: "color.text" | "color.danger";
    surfaceToken: "color.surface" | "color.surface-danger";
  };
}

export interface RequirementCostLimitFormView {
  requirementId: string;
  currentLimit: string | null;
  version: number | null;
  confirmation: "none" | "saved";
}

export interface RequirementCostLimitPageView {
  snapshot: RequirementCostWithLimitSnapshot;
  metric: RequirementCostLimitMetricView;
  form: RequirementCostLimitFormView;
}

/** Parses a decimal-dollar form value without passing through floating point. */
export declare function parseRequirementCostLimitInput(rawLimitUsd: string): ParsedRequirementCostLimit;

/**
 * Saves only the selected requirement. Validation errors and stale forms are
 * returned as values; storage failures remain operational exceptions.
 */
export declare function saveRequirementCostLimit(
  request: SaveRequirementCostLimitRequest,
  store: RequirementCostLimitStore,
): Promise<SaveRequirementCostLimitResponse>;

/** Builds the costs-page metric and form from one central snapshot. */
export declare function presentRequirementCostLimit(
  snapshot: RequirementCostWithLimitSnapshot,
): RequirementCostLimitPageView;

/** Loads one requirement without introducing any daily-limit read or setting. */
export declare function loadRequirementCostLimit(
  requirementId: string,
  reader: RequirementCostLimitReadPort,
): Promise<RequirementCostLimitPageView | null>;
