import { createClient, type Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlDailyCostReadPort, type DailyCostSelection } from "./daily-costs.js";
import {
  formatUsd,
  reduceDailyCostView,
  type DailyCostViewState,
} from "../../console-ui/src/costs/contracts.js";

const T_0620_1530 = Date.parse("2025-06-20T15:30:00Z");
const T_0620_1630 = Date.parse("2025-06-20T16:30:00Z");
const T_0620_1800 = Date.parse("2025-06-20T18:00:00Z");
const T_0622_1200 = Date.parse("2025-06-22T12:00:00Z");

const selection: DailyCostSelection = { timeZone: "Asia/Shanghai", startDate: "2025-06-20", endDate: "2025-06-21" };

async function memoryPort(): Promise<{ client: Client; port: LibsqlDailyCostReadPort }> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  return { client, port: new LibsqlDailyCostReadPort(client, () => 1_700_000_000_000) };
}

async function seedCost(
  client: Client,
  id: number,
  ts: number,
  costUsd: number,
  isSubscription = 0,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO cost_entries (id, run_id, provider, model_id, cost_usd, is_subscription, ts)
          VALUES (?, 'run-1', 'anthropic', 'claude', ?, ?, ?)`,
    args: [id, costUsd, isSubscription, ts],
  });
}

describe("daily cost read boundary", () => {
  it("@scenario S-R237511CO-01-empty 所选范围没有费用时返回空日期集合", async () => {
    const { client, port } = await memoryPort();
    try {
      await seedCost(client, 9, T_0622_1200, 9);

      const result = await port.readDailyCosts({
        timeZone: "Asia/Shanghai",
        startDate: "2025-06-24",
        endDate: "2025-06-25",
      });

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.snapshot.days).toEqual([]);
      expect(result.snapshot.totalUsd).toBe(0);
      expect(result.snapshot.pendingBilling).toBe("settled");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-01-empty 空结果不补出起止日期的零金额行", () => {
    const emptySelection = { timeZone: "Asia/Shanghai", startDate: "2025-06-24", endDate: "2025-06-25" };
    const loading: DailyCostViewState = { status: "loading", selection: emptySelection, requestId: 4 };

    const next = reduceDailyCostView(loading, {
      type: "loaded",
      requestId: 4,
      snapshot: {
        selection: emptySelection,
        scope: "按 Asia/Shanghai 自然日 · 美元",
        days: [],
        totalUsd: 0,
        pendingBilling: "settled",
      },
    });

    expect(next.status).toBe("empty");
    expect(JSON.stringify(next)).not.toContain("0.00");
  });

  it("@scenario S-R237511CO-01-error 费用记录读取失败时返回失败结果", async () => {
    const { client, port } = await memoryPort();
    try {
      await seedCost(client, 1, T_0620_1530, 1.2);
      await seedCost(client, 2, T_0620_1630, 2.3);

      const healthy = await port.readDailyCosts(selection);
      expect(healthy.kind).toBe("ok");
      if (healthy.kind !== "ok") return;
      expect(healthy.snapshot.totalUsd).toBeCloseTo(3.5, 6);

      const brokenClient = {
        execute: () => Promise.reject(new Error("ledger unavailable")),
      } as unknown as Client;
      const broken = new LibsqlDailyCostReadPort(brokenClient, () => 1_700_000_000_000);
      const failed = await broken.readDailyCosts(selection);

      expect(failed.kind).toBe("failed");
      expect(JSON.stringify(failed)).not.toContain("3.5");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-01-error 读取失败保留所选时区与日期且不显示过期金额", () => {
    const ready: DailyCostViewState = {
      status: "ready",
      selection,
      requestId: 3,
      snapshot: {
        selection,
        scope: "按 Asia/Shanghai 自然日 · 美元",
        days: [{ date: "2025-06-20", costUsd: 3.5, count: 2 }],
        totalUsd: 3.5,
        pendingBilling: "settled",
      },
    };

    const next = reduceDailyCostView(ready, { type: "failed", requestId: 3 });

    expect(next.status).toBe("error");
    if (next.status !== "error") return;
    expect(next.selection).toEqual(selection);
    expect(JSON.stringify(next)).not.toContain("3.5");
  });

  it("@scenario S-R237511CO-01-waiting 最新使用未计费时保留已有历史金额", async () => {
    const { client, port } = await memoryPort();
    try {
      await seedCost(client, 1, T_0620_1530, 3.5);
      await client.execute({
        sql: `INSERT INTO turn_usage (run_id, turn, provider, model_id, ts)
              VALUES ('run-1', 2, 'anthropic', 'claude', ?)`,
        args: [T_0620_1800],
      });

      const result = await port.readDailyCosts(selection);

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.snapshot.pendingBilling).toBe("pending_latest_usage");
      expect(result.snapshot.days.map((day) => day.date)).toEqual(["2025-06-20"]);
      expect(result.snapshot.totalUsd).toBeCloseTo(3.5, 6);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511CO-01-waiting 等待计费时历史金额保持可见", () => {
    const loading: DailyCostViewState = { status: "loading", selection, requestId: 5 };

    const next = reduceDailyCostView(loading, {
      type: "loaded",
      requestId: 5,
      snapshot: {
        selection,
        scope: "按 Asia/Shanghai 自然日 · 美元",
        days: [{ date: "2025-06-20", costUsd: 3.5, count: 1 }],
        totalUsd: 3.5,
        pendingBilling: "pending_latest_usage",
      },
    });

    expect(next.status).toBe("waiting");
    if (next.status !== "waiting") return;
    expect(next.snapshot.totalUsd).toBeCloseTo(3.5, 6);
    expect(formatUsd(next.snapshot.totalUsd)).toBe("$3.50");
  });

  it("@scenario S-R237511CO-01-utc 较慢的上海结果不能覆盖较新的UTC选择", () => {
    const shanghai = { timeZone: "Asia/Shanghai", startDate: "2025-06-20", endDate: "2025-06-21" };
    const utc = { timeZone: "UTC", startDate: "2025-06-20", endDate: "2025-06-21" };
    const ready: DailyCostViewState = {
      status: "ready",
      selection: shanghai,
      requestId: 1,
      snapshot: {
        selection: shanghai,
        scope: "按 Asia/Shanghai 自然日 · 美元",
        days: [
          { date: "2025-06-20", costUsd: 1.2, count: 1 },
          { date: "2025-06-21", costUsd: 2.3, count: 1 },
        ],
        totalUsd: 3.5,
        pendingBilling: "settled",
      },
    };

    const loading = reduceDailyCostView(ready, { type: "select", selection: utc, requestId: 2 });

    expect(loading.status).toBe("loading");
    if (loading.status !== "loading") return;
    expect(loading.selection.timeZone).toBe("UTC");

    const stale = reduceDailyCostView(loading, {
      type: "loaded",
      requestId: 1,
      snapshot: {
        selection: shanghai,
        scope: "按 Asia/Shanghai 自然日 · 美元",
        days: [
          { date: "2025-06-20", costUsd: 1.2, count: 1 },
          { date: "2025-06-21", costUsd: 2.3, count: 1 },
        ],
        totalUsd: 3.5,
        pendingBilling: "settled",
      },
    });

    expect(stale.status).toBe("loading");
    if (stale.status !== "loading") return;
    expect(stale.requestId).toBe(2);
    expect(JSON.stringify(stale)).not.toContain("06-21");
  });
});
