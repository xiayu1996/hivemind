import { createClient, type Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import * as ledgerRuntime from "./requirement-cost-ledger.js";
import type {
  HistoricalCostLedger,
  HistoricalUsageCostInput,
  OfficialPriceCatalog,
  OfficialPriceLookup,
  OfficialUnitPrice,
  RequirementCostReadPort,
} from "./requirement-cost-ledger.js";

type LedgerConstructor = new (client: Client, catalog: OfficialPriceCatalog) => HistoricalCostLedger;
type ReadPortConstructor = new (client: Client, now?: () => number) => RequirementCostReadPort;
type RuntimeExports = {
  LibsqlHistoricalCostLedger?: LedgerConstructor;
  LibsqlRequirementCostReadPort?: ReadPortConstructor;
};

const runtime = ledgerRuntime as RuntimeExports;
const OLD_AT = Date.parse("2025-06-20T12:00:00Z");
const CHANGE_AT = Date.parse("2025-07-01T00:00:00Z");
const NEW_AT = Date.parse("2025-07-02T12:00:00Z");

class MutablePriceCatalog implements OfficialPriceCatalog {
  readonly lookups: OfficialPriceLookup[] = [];

  constructor(
    public resolve: (lookup: OfficialPriceLookup) => OfficialUnitPrice | null,
  ) {}

  async findOfficialUnitPrice(lookup: OfficialPriceLookup): Promise<OfficialUnitPrice | null> {
    this.lookups.push(lookup);
    return this.resolve(lookup);
  }
}

function price(
  id: string,
  usdPerMillionTokens: string,
  effectiveFromMs = 0,
  effectiveUntilMs: number | null = null,
): OfficialUnitPrice {
  return {
    priceVersionId: id,
    effectiveFromMs,
    effectiveUntilMs,
    usdPerMillionTokens,
    sourceReference: `https://prices.example/${id}`,
  };
}

function constructors(): { Ledger: LedgerConstructor; ReadPort: ReadPortConstructor } {
  expect(runtime.LibsqlHistoricalCostLedger, "LibsqlHistoricalCostLedger export").toBeTypeOf("function");
  expect(runtime.LibsqlRequirementCostReadPort, "LibsqlRequirementCostReadPort export").toBeTypeOf("function");
  return {
    Ledger: runtime.LibsqlHistoricalCostLedger as LedgerConstructor,
    ReadPort: runtime.LibsqlRequirementCostReadPort as ReadPortConstructor,
  };
}

async function fixture(catalog: OfficialPriceCatalog): Promise<{
  client: Client;
  ledger: HistoricalCostLedger;
  reader: RequirementCostReadPort;
}> {
  const { Ledger, ReadPort } = constructors();
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  await client.batch([
    `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
     VALUES ('R-main', 'page-main', 'Main', 'EXECUTING', 'Main request', 1, 1)`,
    `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
     VALUES ('R-other', 'page-other', 'Other', 'EXECUTING', 'Other request', 1, 1)`,
    `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
     VALUES ('E-main', 'epic-main', 'Main epic', 'EXECUTING', 'R-main', 1, 1)`,
    `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
     VALUES ('E-other', 'epic-other', 'Other epic', 'EXECUTING', 'R-other', 1, 1)`,
    `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at)
     VALUES ('S-old', 'E-main', 'story-old', 'Old work', 'work', 'DELIVERED', 1, 1)`,
    `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at)
     VALUES ('S-current', 'E-main', 'story-current', 'Current work', 'work', 'CODE', 1, 1)`,
    `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at)
     VALUES ('S-other', 'E-other', 'story-other', 'Other work', 'work', 'DELIVERED', 1, 1)`,
  ], "write");
  return {
    client,
    ledger: new Ledger(client, catalog),
    reader: new ReadPort(client, () => NEW_AT + 1),
  };
}

function usage(
  usageEventId: string,
  overrides: Partial<HistoricalUsageCostInput> = {},
): HistoricalUsageCostInput {
  return {
    usageEventId,
    requirementId: "R-main",
    workItemId: "S-old",
    roundId: "round-1",
    occurredAtMs: OLD_AT,
    provider: "metered-provider",
    model: "model-a",
    billingMode: "metered",
    usage: { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function categoryPrice(lookup: OfficialPriceLookup): OfficialUnitPrice {
  const rates = {
    uncached_input: "1.25",
    output: "2.00",
    cache_read: "0.20",
    cache_write: "1.00",
  } as const;
  return price(`${lookup.provider}-${lookup.category}`, rates[lookup.category]);
}

describe("historical requirement cost ledger", () => {
  it("@scenario S-R237511CO-02-breakdown 四种分类和两种付费方式分别留下可核对明细", async () => {
    const catalog = new MutablePriceCatalog(categoryPrice);
    const { client, ledger, reader } = await fixture(catalog);
    try {
      await ledger.recordUsage(usage("metered-usage", {
        usage: { uncachedInput: 2_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      }));
      await ledger.recordUsage(usage("subscription-usage", {
        workItemId: "S-current",
        roundId: "round-3",
        provider: "subscription-provider",
        model: "model-b",
        billingMode: "subscription",
        usage: { uncachedInput: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 500_000 },
      }));

      const snapshot = await reader.readRequirementCost("R-main");
      expect(snapshot.entries).toHaveLength(4);
      expect(snapshot.entries.map((entry) => entry.category)).toEqual([
        "uncached_input",
        "output",
        "cache_read",
        "cache_write",
      ]);
      expect(snapshot.entries.map((entry) => entry.billingMode)).toEqual([
        "metered",
        "metered",
        "subscription",
        "subscription",
      ]);
      expect(snapshot.entries.map((entry) => entry.tokenCount)).toEqual([
        2_000_000,
        1_000_000,
        1_000_000,
        500_000,
      ]);
      expect(snapshot.entries.map((entry) => entry.pricingStatus === "priced" ? entry.usdPerMillionTokens : null))
        .toEqual(["1.25", "2.00", "0.20", "1.00"]);
      expect(snapshot.entries.map((entry) => entry.pricingStatus === "priced" ? Number(entry.amountUsd) : null))
        .toEqual([2.5, 2, 0.2, 0.5]);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-02-breakdown 零用量不生成明细且任一分类计价失败时整笔不落半条记录", async () => {
    const catalog = new MutablePriceCatalog((lookup) => {
      if (lookup.category === "output") throw new Error("catalog unavailable");
      return categoryPrice(lookup);
    });
    const { client, ledger, reader } = await fixture(catalog);
    try {
      await expect(ledger.recordUsage(usage("atomic-usage", {
        usage: { uncachedInput: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      }))).rejects.toThrow("catalog unavailable");

      const snapshot = await reader.readRequirementCost("R-main");
      expect(snapshot.entries).toEqual([]);
      expect(catalog.lookups.map((lookup) => lookup.category)).not.toContain("cache_read");
      expect(catalog.lookups.map((lookup) => lookup.category)).not.toContain("cache_write");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-02-frozen 调价前后使用各自固化发生时单价且旧金额不被重算", async () => {
    const catalog = new MutablePriceCatalog((lookup) => lookup.occurredAtMs < CHANGE_AT
      ? price("price-v1", "1.00", 0, CHANGE_AT)
      : price("price-v2", "2.00", CHANGE_AT));
    const { client, ledger, reader } = await fixture(catalog);
    try {
      await ledger.recordUsage(usage("before-change", {
        occurredAtMs: OLD_AT,
        usage: { uncachedInput: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      }));
      await ledger.recordUsage(usage("after-change", {
        workItemId: "S-current",
        roundId: "round-3",
        occurredAtMs: NEW_AT,
        usage: { uncachedInput: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      }));
      catalog.resolve = () => price("price-v3", "9.00", NEW_AT + 1);

      const snapshot = await reader.readRequirementCost("R-main");
      expect(snapshot.total).toEqual({ completeness: "complete", totalUsd: "3.00" });
      expect(snapshot.entries.map((entry) => entry.pricingStatus === "priced"
        ? [entry.priceVersionId, entry.usdPerMillionTokens, entry.amountUsd]
        : null)).toEqual([
        ["price-v1", "1.00", "1.00"],
        ["price-v2", "2.00", "2.00"],
      ]);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-02-frozen 生效边界采用新价且重复并发写入不重复计费或重新定价", async () => {
    const catalog = new MutablePriceCatalog((lookup) => lookup.occurredAtMs < CHANGE_AT
      ? price("price-v1", "1.00", 0, CHANGE_AT)
      : price("price-v2", "2.00", CHANGE_AT));
    const { client, ledger, reader } = await fixture(catalog);
    try {
      const boundaryUsage = usage("boundary-usage", {
        occurredAtMs: CHANGE_AT,
        usage: { uncachedInput: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      });
      const [first, duplicate] = await Promise.all([
        ledger.recordUsage(boundaryUsage),
        ledger.recordUsage(boundaryUsage),
      ]);
      expect(first).toHaveLength(1);
      expect(duplicate).toHaveLength(1);
      expect(first[0]).toMatchObject({ priceVersionId: "price-v2", usdPerMillionTokens: "2.00", amountUsd: "2.00" });
      expect(duplicate[0]).toMatchObject({ entryId: first[0]?.entryId, amountUsd: "2.00" });

      const lookupsBeforeRetry = catalog.lookups.length;
      catalog.resolve = () => price("price-v3", "9.00", CHANGE_AT);
      const retry = await ledger.recordUsage(boundaryUsage);
      expect(retry[0]).toMatchObject({ entryId: first[0]?.entryId, usdPerMillionTokens: "2.00", amountUsd: "2.00" });
      expect(catalog.lookups).toHaveLength(lookupsBeforeRetry);
      expect((await reader.readRequirementCost("R-main")).entries).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-02-total 汇总全部历史与当前轮并将订阅制费用计入累计", async () => {
    const catalog = new MutablePriceCatalog((lookup) => {
      const rates: Record<string, string> = {
        "metered-provider/model-metered": "4.35",
        "subscription-provider/model-history": "6.70",
        "subscription-provider/model-current": "2.00",
        "other-provider/model-other": "99.00",
      };
      return price(`${lookup.provider}-${lookup.model}`, rates[`${lookup.provider}/${lookup.model}`] ?? "1.00");
    });
    const { client, ledger, reader } = await fixture(catalog);
    try {
      await ledger.recordUsage(usage("completed-metered", {
        model: "model-metered",
        roundId: "round-completed",
        usage: { uncachedInput: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      }));
      await ledger.recordUsage(usage("reworked-subscription", {
        provider: "subscription-provider",
        model: "model-history",
        billingMode: "subscription",
        roundId: "round-rework",
        occurredAtMs: OLD_AT + 1,
        usage: { uncachedInput: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      }));
      await ledger.recordUsage(usage("current-subscription", {
        workItemId: "S-current",
        provider: "subscription-provider",
        model: "model-current",
        billingMode: "subscription",
        roundId: "round-current",
        occurredAtMs: OLD_AT + 2,
        usage: { uncachedInput: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      }));

      const snapshot = await reader.readRequirementCost("R-main");
      expect(snapshot.requirementId).toBe("R-main");
      expect(snapshot.total).toEqual({ completeness: "complete", totalUsd: "13.05" });
      expect(snapshot.ceilingJudgment).toEqual({ basis: "metered_only", amountUsd: "4.35" });
      expect(snapshot.entries.map((entry) => entry.roundId)).toEqual([
        "round-completed",
        "round-rework",
        "round-current",
      ]);
      expect(snapshot.entries.filter((entry) => entry.billingMode === "subscription")).toHaveLength(2);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-02-total 其他需求费用不进入累计且查看范围没有轮次筛选入口", async () => {
    const catalog = new MutablePriceCatalog((lookup) => price(`${lookup.provider}-${lookup.model}`, "5.00"));
    const { client, ledger, reader } = await fixture(catalog);
    try {
      await ledger.recordUsage(usage("main-usage", {
        usage: { uncachedInput: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      }));
      await ledger.recordUsage(usage("other-usage", {
        requirementId: "R-other",
        workItemId: "S-other",
        provider: "other-provider",
        model: "model-other",
        usage: { uncachedInput: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      }));

      const snapshot = await reader.readRequirementCost("R-main");
      const refreshed = await reader.readRequirementCost("R-main");
      expect(snapshot.total).toEqual({ completeness: "complete", totalUsd: "5.00" });
      expect(snapshot.entries.map((entry) => entry.usageEventId)).toEqual(["main-usage"]);
      expect(refreshed.total).toEqual(snapshot.total);
      expect(refreshed.entries.map((entry) => entry.entryId)).toEqual(
        snapshot.entries.map((entry) => entry.entryId),
      );
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-02-unpriced 缺少发生时价格时保留已知小计并明确列出缺价明细", async () => {
    const catalog = new MutablePriceCatalog((lookup) => lookup.model === "known-model"
      ? price("known-price", "3.00")
      : null);
    const { client, ledger, reader } = await fixture(catalog);
    try {
      await ledger.recordUsage(usage("known-usage", {
        model: "known-model",
        usage: { uncachedInput: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      }));
      await ledger.recordUsage(usage("missing-usage", {
        workItemId: "S-current",
        occurredAtMs: NEW_AT,
        provider: "subscription-provider",
        model: "missing-model",
        billingMode: "subscription",
        usage: { uncachedInput: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      }));

      const snapshot = await reader.readRequirementCost("R-main");
      expect(snapshot.total).toEqual({
        completeness: "incomplete",
        knownSubtotalUsd: "3.00",
        missingPriceCount: 1,
      });
      const missing = snapshot.entries.find((entry) => entry.usageEventId === "missing-usage");
      expect(missing).toEqual(expect.objectContaining({
        occurredAtMs: NEW_AT,
        provider: "subscription-provider",
        model: "missing-model",
        category: "cache_read",
        pricingStatus: "unpriced",
        reason: "official_price_unavailable_at_occurrence",
      }));
      expect(missing).not.toHaveProperty("usdPerMillionTokens");
      expect(missing).not.toHaveProperty("amountUsd");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-02-unpriced 当前已有价格也不能回填发生时缺价使用或按零美元冒充完整累计", async () => {
    const catalog = new MutablePriceCatalog((lookup) => lookup.occurredAtMs >= CHANGE_AT
      ? price("current-price", "2.00", CHANGE_AT)
      : null);
    const { client, ledger, reader } = await fixture(catalog);
    try {
      await ledger.recordUsage(usage("historically-unpriced", {
        occurredAtMs: OLD_AT,
        model: "later-priced-model",
        usage: { uncachedInput: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      }));

      const snapshot = await reader.readRequirementCost("R-main");
      expect(catalog.lookups).toEqual([expect.objectContaining({ occurredAtMs: OLD_AT, category: "output" })]);
      expect(snapshot.total).toEqual({
        completeness: "incomplete",
        knownSubtotalUsd: "0.00",
        missingPriceCount: 1,
      });
      expect(snapshot.total.completeness).not.toBe("complete");
      expect(snapshot.entries[0]).not.toHaveProperty("amountUsd", "0.00");
    } finally {
      client.close();
    }
  });
});
