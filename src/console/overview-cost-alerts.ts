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
export function presentOverviewCostAlert(snapshot: OverLimitRequirementSnapshot): OverviewCostAlertRow {  return {
    requirementId: snapshot.requirementId,
    requirementTitle: snapshot.title,
    requirementState: snapshot.requirementState,
    status: "over_limit",
    statusText: "已超限",
    continuationText: "工作仍会继续",
    visual: { colorToken: "color.danger", surfaceToken: "color.surface-danger" },
  };
}

/** The alert summary for a set of already-read over-limit requirements. */
export function toOverviewCostAlertsView(
  snapshots: readonly OverLimitRequirementSnapshot[],
): OverviewCostAlertsView {
  const rows = snapshots.map(presentOverviewCostAlert);
  return { count: rows.length, heading: `费用已超限 ${rows.length}`, rows };
}

/**
 * This projection is read-only. Dispatch, responsibility items, and stop
 * reasons must not depend on it, so crossing a requirement limit cannot pause
 * work or create a human action.
 */
export async function loadOverviewCostAlerts(
  reader: RequirementCostLimitReadPort,
): Promise<OverviewCostAlertsView> {
  return toOverviewCostAlertsView(await reader.listOverLimitRequirements());
}
