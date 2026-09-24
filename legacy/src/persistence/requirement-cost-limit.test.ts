import { describe, expect, it } from "vitest";
import * as costLimitRuntime from "./requirement-cost-limit.js";
import type {
  RequirementCostLimitAssessment,
  RequirementCostLimitRecord,
  UsdCents,
} from "./requirement-cost-limit.js";
import type { RequirementCostTotal } from "./requirement-cost-ledger.js";

type AssessRequirementCostLimit = (
  total: RequirementCostTotal,
  limit: RequirementCostLimitRecord | null,
) => RequirementCostLimitAssessment;

type RuntimeExports = {
  assessRequirementCostLimit?: AssessRequirementCostLimit;
};

const runtime = costLimitRuntime as RuntimeExports;

function cents(value: number): UsdCents {
  return value as UsdCents;
}

function limit(limitUsdCents = 1_500): RequirementCostLimitRecord {
  return {
    requirementId: "R-main",
    limitUsdCents: cents(limitUsdCents),
    version: 1,
    updatedAtMs: 1_700_000_000_000,
    updatedBy: "owner",
  };
}

function assessor(): AssessRequirementCostLimit {
  expect(runtime.assessRequirementCostLimit, "assessRequirementCostLimit export").toBeTypeOf("function");
  return runtime.assessRequirementCostLimit as AssessRequirementCostLimit;
}

describe("whole-history requirement cost limit assessment", () => {
  it("@scenario S-R237511CO-03-crosslimit 新一轮费用使累计金额从上限变为超限", () => {
    const before = assessor()({ completeness: "complete", totalUsd: "15.00" }, limit());
    const after = assessor()({ completeness: "complete", totalUsd: "17.22" }, limit());

    expect(before).toEqual({
      status: "within_limit",
      totalUsdCents: 1_500,
      limitUsdCents: 1_500,
    });
    expect(after).toEqual({
      status: "over_limit",
      totalUsdCents: 1_722,
      limitUsdCents: 1_500,
      excessUsdCents: 222,
    });
  });

  it("@scenario S-R237511CO-03-crosslimit 累计金额等于上限时不算超限", () => {
    const assessment = assessor()({ completeness: "complete", totalUsd: "15.00" }, limit());

    expect(assessment.status).toBe("within_limit");
    expect(assessment).not.toHaveProperty("excessUsdCents");
  });
});
