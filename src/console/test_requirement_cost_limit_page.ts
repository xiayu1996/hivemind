import { describe, expect, it } from "vitest";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import { renderCostsRoute } from "./costs-page.js";
import { listDailyCostTimeZones, type DailyCostSelection } from "./daily-costs.js";
import { presentRequirementCostLimit, saveRequirementCostLimit } from "./requirement-cost-limit.js";
import type { RequirementCostSnapshot } from "../persistence/requirement-cost-ledger.js";
import type {
  RequirementCostLimitRecord,
  RequirementCostLimitStore,
  RequirementCostWithLimitSnapshot,
  SaveRequirementCostLimitInput,
  SaveRequirementCostLimitResult,
  UsdCents,
} from "../persistence/requirement-cost-limit.js";

const zones = listDailyCostTimeZones();

function cents(value: number): UsdCents {
  return value as UsdCents;
}

/** The central store's versioned rows, held in memory for one requirement each. */
class MemoryLimitStore implements RequirementCostLimitStore {
  private readonly rows = new Map<string, RequirementCostLimitRecord>();

  constructor(seed: readonly RequirementCostLimitRecord[] = []) {
    for (const record of seed) this.rows.set(record.requirementId, record);
  }

  async readRequirementCostLimit(requirementId: string): Promise<RequirementCostLimitRecord | null> {
    return this.rows.get(requirementId) ?? null;
  }

  async saveRequirementCostLimit(input: SaveRequirementCostLimitInput): Promise<SaveRequirementCostLimitResult> {
    const current = this.rows.get(input.requirementId) ?? null;
    if (input.expectedVersion === null) {
      if (current !== null) return { kind: "version_conflict", current };
    } else if (current === null || current.version !== input.expectedVersion) {
      return { kind: "version_conflict", current };
    }
    const record: RequirementCostLimitRecord = {
      requirementId: input.requirementId,
      limitUsdCents: input.limitUsdCents,
      version: (current?.version ?? 0) + 1,
      updatedAtMs: input.updatedAtMs,
      updatedBy: input.updatedBy,
    };
    this.rows.set(input.requirementId, record);
    return { kind: "saved", record };
  }
}

function costSnapshot(requirementId: string, totalUsd: string): RequirementCostSnapshot {
  return {
    requirementId,
    calculatedAtMs: 1_700_000_000_000,
    total: { completeness: "complete", totalUsd },
    ceilingJudgment: { basis: "metered_only", amountUsd: totalUsd },
    entries: [],
  };
}

function snapshotOf(
  requirementId: string,
  totalUsd: string,
  limit: RequirementCostLimitRecord | null,
): RequirementCostWithLimitSnapshot {
  const assessment = limit === null
    ? { status: "not_set" as const }
    : { status: "within_limit" as const, totalUsdCents: cents(0), limitUsdCents: limit.limitUsdCents };
  return { cost: costSnapshot(requirementId, totalUsd), limit, assessment };
}

function consoleData(
  readLimit: (requirementId: string) => Promise<RequirementCostWithLimitSnapshot | null>,
): ConsoleDataSource {
  return {
    nodes: async () => [],
    tasks: async () => [],
    costs: async () => [],
    config: async () => [],
    stats: async () => ({}),
    providers: async () => [],
    queue: async () => ({}),
    dailyCostTimeZones: async () => zones,
    dailyCosts: async (selection: DailyCostSelection) => ({
      kind: "ok",
      snapshot: { selection, days: [], totalUsd: 0, pendingBilling: "settled", generatedAt: 1 },
    }),
    requirementCostWithLimit: readLimit,
    overLimitRequirements: async () => [],
  };
}

describe("the costs page saves one requirement's limit", () => {
  it("@scenario S-R237511CO-03-setlimit 保存当前需求上限后显示金额与已保存且另一需求不变", async () => {
    const other: RequirementCostLimitRecord = {
      requirementId: "R-other",
      limitUsdCents: cents(800),
      version: 1,
      updatedAtMs: 1_700_000_000_000,
      updatedBy: "owner",
    };
    const store = new MemoryLimitStore([other]);

    const response = await saveRequirementCostLimit({
      requirementId: "R-main",
      rawLimitUsd: "15.00",
      expectedVersion: null,
      actor: "owner",
      nowMs: 1_700_000_100_000,
    }, store);

    expect(response).toEqual({
      kind: "saved",
      record: {
        requirementId: "R-main",
        limitUsdCents: 1_500,
        version: 1,
        updatedAtMs: 1_700_000_100_000,
        updatedBy: "owner",
      },
    });
    expect(await store.readRequirementCostLimit("R-other")).toEqual(other);

    const record = response.kind === "saved" ? response.record : null;
    const view = presentRequirementCostLimit(snapshotOf("R-main", "0.00", record), "saved");
    expect(view.metric.configuredLimit).toBe("$15.00");
    expect(view.form.confirmation).toBe("saved");
    expect(view.form.confirmationText).toBe("上限已保存");
    expect(view.form.version).toBe(1);
  });

  it("@scenario S-R237511CO-03-setlimit 费用分析页为当前需求显示上限与已保存提示", async () => {
    const other: RequirementCostLimitRecord = {
      requirementId: "R-other",
      limitUsdCents: cents(800),
      version: 1,
      updatedAtMs: 1_700_000_000_000,
      updatedBy: "owner",
    };
    const store = new MemoryLimitStore([other]);
    await saveRequirementCostLimit({
      requirementId: "R-main",
      rawLimitUsd: "15.00",
      expectedVersion: null,
      actor: "owner",
      nowMs: 1_700_000_100_000,
    }, store);
    const record = await store.readRequirementCostLimit("R-main");

    const html = await renderCostsRoute(
      { requirement: "R-main", timeZone: "Asia/Shanghai", limitSaved: "1" },
      zones,
      (selection) => Promise.resolve({
        kind: "ok",
        snapshot: { selection, days: [], totalUsd: 0, pendingBilling: "settled", generatedAt: 1 },
      }),
      0,
      async (requirementId) => (requirementId === "R-main" ? snapshotOf("R-main", "0.00", record) : null),
    );

    expect(html).toContain("<h1>费用分析</h1>");
    expect(html).toContain("需求费用上限");
    expect(html).toContain("$15.00");
    expect(html).toContain("保存上限");
    expect(html).toContain("上限已保存");
    // The other requirement's $8.00 limit never appears on this one's page.
    expect(html).not.toContain("$8.00");
  });

  it("@scenario S-R237511CO-03-setlimit 提交表单只写入当前需求并把已保存带回页面", async () => {
    const other: RequirementCostLimitRecord = {
      requirementId: "R-other",
      limitUsdCents: cents(800),
      version: 1,
      updatedAtMs: 1_700_000_000_000,
      updatedBy: "owner",
    };
    const store = new MemoryLimitStore([other]);
    const app = await createConsoleServer(
      consoleData(async (requirementId) => {
        if (requirementId !== "R-main") return null;
        return snapshotOf("R-main", "0.00", await store.readRequirementCostLimit("R-main"));
      }),
      { serveUi: false, costLimitStore: store },
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/costs/requirement-limit",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "requirementId=R-main&limitUsd=15.00",
      });
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/costs?requirement=R-main&limitSaved=1");
      expect((await store.readRequirementCostLimit("R-main"))?.limitUsdCents).toBe(1_500);
      expect(await store.readRequirementCostLimit("R-other")).toEqual(other);
    } finally {
      await app.close();
    }
  });
});
