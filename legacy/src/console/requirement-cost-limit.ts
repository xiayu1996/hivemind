import {
  formatUsdCents,
  type RequirementCostLimitAssessment,
  type RequirementCostLimitReadPort,
  type RequirementCostLimitRecord,
  type RequirementCostLimitStore,
  type RequirementCostWithLimitSnapshot,
  type SaveRequirementCostLimitResult,
  type UsdCents,
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
  confirmationText: string | null;
}

export interface RequirementCostLimitPageView {
  snapshot: RequirementCostWithLimitSnapshot;
  metric: RequirementCostLimitMetricView;
  form: RequirementCostLimitFormView;
}

/** A decimal dollar amount with at most one decimal point, as typed into the form. */
const DECIMAL_INPUT = /^(\d+)(?:\.(\d+))?$/;

/** Parses a decimal-dollar form value without passing through floating point. */
export function parseRequirementCostLimitInput(rawLimitUsd: string): ParsedRequirementCostLimit {
  const trimmed = rawLimitUsd.trim();
  if (trimmed === "") return { ok: false, error: "required" };
  if (trimmed.startsWith("-")) return { ok: false, error: "negative" };
  const match = DECIMAL_INPUT.exec(trimmed);
  if (!match) return { ok: false, error: "invalid_usd" };
  const [, whole, fraction = ""] = match;
  if (fraction.length > 2) return { ok: false, error: "more_than_two_decimal_places" };
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { ok: false, error: "outside_safe_range" };
  return { ok: true, value: cents as UsdCents };
}

/**
 * Saves only the selected requirement. Validation errors and stale forms are
 * returned as values; storage failures remain operational exceptions.
 */
export async function saveRequirementCostLimit(
  request: SaveRequirementCostLimitRequest,
  store: RequirementCostLimitStore,
): Promise<SaveRequirementCostLimitResponse> {
  const parsed = parseRequirementCostLimitInput(request.rawLimitUsd);
  if (!parsed.ok) return { kind: "validation_failed", error: parsed.error };
  return store.saveRequirementCostLimit({
    requirementId: request.requirementId,
    limitUsdCents: parsed.value,
    expectedVersion: request.expectedVersion,
    updatedAtMs: request.nowMs,
    updatedBy: request.actor,
  });
}

/** The cumulative figure as shown, whichever shape the snapshot carries. */
function cumulativeAmountOf(snapshot: RequirementCostWithLimitSnapshot): string {
  const total = snapshot.cost.total;
  return total.completeness === "complete"
    ? `$${total.totalUsd}`
    : `$${total.knownSubtotalUsd}`;
}

type RequirementCostLimitAssessmentView = Omit<RequirementCostLimitMetricView, "cumulativeAmount" | "configuredLimit">;

function metricOf(assessment: RequirementCostLimitAssessment): RequirementCostLimitAssessmentView {
  switch (assessment.status) {
    case "not_set":
      return {
        status: "not_set",
        statusText: "未设置上限",
        continuationText: null,
        visual: { colorToken: "color.text", surfaceToken: "color.surface" },
      };
    case "within_limit":
      return {
        status: "within_limit",
        statusText: "未超限",
        continuationText: null,
        visual: { colorToken: "color.text", surfaceToken: "color.surface" },
      };
    case "over_limit":
      return {
        status: "over_limit",
        statusText: `已超限 ${formatUsdCents(assessment.excessUsdCents)}`,
        continuationText: "工作仍会继续",
        visual: { colorToken: "color.danger", surfaceToken: "color.surface-danger" },
      };
    case "over_limit_at_least":
      return {
        status: "over_limit",
        statusText: `已超限至少 ${formatUsdCents(assessment.minimumExcessUsdCents)}`,
        continuationText: "工作仍会继续",
        visual: { colorToken: "color.danger", surfaceToken: "color.surface-danger" },
      };
    case "indeterminate":
      return {
        status: "incomplete",
        statusText: "费用暂不完整",
        continuationText: null,
        visual: { colorToken: "color.text", surfaceToken: "color.surface" },
      };
  }
}

/** Builds the costs-page metric and form from one central snapshot. */
export function presentRequirementCostLimit(
  snapshot: RequirementCostWithLimitSnapshot,
  confirmation: "none" | "saved" = "none",
): RequirementCostLimitPageView {
  return {
    snapshot,
    metric: {
      cumulativeAmount: cumulativeAmountOf(snapshot),
      configuredLimit: snapshot.limit === null ? null : formatUsdCents(snapshot.limit.limitUsdCents),
      ...metricOf(snapshot.assessment),
    },
    form: {
      requirementId: snapshot.cost.requirementId,
      currentLimit: snapshot.limit === null ? null : formatUsdCents(snapshot.limit.limitUsdCents),
      version: snapshot.limit?.version ?? null,
      confirmation,
      confirmationText: confirmation === "saved" ? "上限已保存" : null,
    },
  };
}

/** Loads one requirement without introducing any daily-limit read or setting. */
export async function loadRequirementCostLimit(
  requirementId: string,
  reader: RequirementCostLimitReadPort,
): Promise<RequirementCostLimitPageView | null> {
  const snapshot = await reader.readRequirementCostWithLimit(requirementId);
  if (snapshot === null) return null;
  return presentRequirementCostLimit(snapshot);
}
