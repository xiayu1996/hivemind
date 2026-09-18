import type {
  OverLimitRequirementSnapshot,
  RequirementCostLimitReadPort,
} from "../persistence/requirement-cost-limit.js";

export interface OverviewCostAlertRow {
  requirementId: string;
  requirementTitle: string;
  requirementState: string;
  status: "over_limit";
  statusText: string;
  continuationText: string;
  visual: {
    colorToken: "color.danger";
    surfaceToken: "color.surface-danger";
  };
}

export interface OverviewCostAlertsView {
  count: number;
  heading: string;
  rows: readonly OverviewCostAlertRow[];
}

/** Maps one definite alert without translating it into a paused state. */
export declare function presentOverviewCostAlert(
  snapshot: OverLimitRequirementSnapshot,
): OverviewCostAlertRow;

/**
 * This projection is read-only. Dispatch, responsibility items, and stop
 * reasons must not depend on it, so crossing a requirement limit cannot pause
 * work or create a human action.
 */
export declare function loadOverviewCostAlerts(
  reader: RequirementCostLimitReadPort,
): Promise<OverviewCostAlertsView>;
