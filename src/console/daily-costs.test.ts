import { describe, expect, it } from "vitest";
import {
  DailyCostSelectionError,
  aggregateDailyCosts,
  listDailyCostTimeZones,
  validateDailyCostSelection,
  type DailyCostEntry,
} from "./daily-costs.js";
import { formatDailyCostScope } from "../../console-ui/src/costs/contracts.js";

function entry(id: number, isoTs: string, costUsd: number, isSubscription = false): DailyCostEntry {
  return { id, ts: Date.parse(isoTs), costUsd, isSubscription };
}

const shanghaiSelection = { timeZone: "Asia/Shanghai", startDate: "2025-06-20", endDate: "2025-06-21" };

describe("daily costs by natural-day zone", () => {
  it("@scenario S-R237511CO-01-shanghai 上海自然日把两笔费用分到相邻两日且范围外不计入", () => {
    const entries = [
      entry(1, "2025-06-20T15:30:00Z", 1.2),
      entry(2, "2025-06-20T16:30:00Z", 2.3, true),
      entry(9, "2025-06-22T12:00:00Z", 9),
    ];

    const days = aggregateDailyCosts(entries, shanghaiSelection);

    expect(days.length).toBe(2);
    expect(days.map((day) => day.date)).toEqual(["2025-06-20", "2025-06-21"]);
    expect(days.map((day) => day.count)).toEqual([1, 1]);
    expect(days[0]?.costUsd).toBeCloseTo(1.2, 6);
    expect(days[1]?.costUsd).toBeCloseTo(2.3, 6);
    expect(days.reduce((sum, day) => sum + day.costUsd, 0)).toBeCloseTo(3.5, 6);
  });

  it("@scenario S-R237511CO-01-shanghai 每日费用写明所选时区与美元口径", () => {
    expect(formatDailyCostScope("Asia/Shanghai")).toBe("按 Asia/Shanghai 自然日 · 美元");
  });

  it("@scenario S-R237511CO-01-shanghai 同一费用编号重复出现时拒绝汇总", () => {
    const entries = [
      entry(1, "2025-06-20T15:30:00Z", 1.2),
      entry(1, "2025-06-20T15:30:00Z", 1.2),
    ];

    expect(() => aggregateDailyCosts(entries, shanghaiSelection)).toThrow();
  });

  it("@scenario S-R237511CO-01-shanghai 时区可选项覆盖运行时全部地区时区并单列UTC", () => {
    const zones = listDailyCostTimeZones();
    const ids = zones.map((zone) => zone.id);

    expect(ids).toContain("Asia/Shanghai");
    expect(ids).toEqual([...new Set([...Intl.supportedValuesOf("timeZone"), "UTC"])].sort());
    expect(zones.find((zone) => zone.id === "Asia/Shanghai")?.label).toBe("Asia/Shanghai (UTC+8)");
  });

  it("@scenario S-R237511CO-01-utc 切到UTC后两笔费用合并到同一自然日", () => {
    const entries = [
      entry(1, "2025-06-20T15:30:00Z", 1.2),
      entry(2, "2025-06-20T16:30:00Z", 2.3),
      entry(9, "2025-06-22T12:00:00Z", 9),
    ];

    const days = aggregateDailyCosts(entries, { timeZone: "UTC", startDate: "2025-06-20", endDate: "2025-06-21" });

    expect(days.length).toBe(1);
    expect(days.map((day) => day.date)).toEqual(["2025-06-20"]);
    expect(days.map((day) => day.count)).toEqual([2]);
    expect(days[0]?.costUsd).toBeCloseTo(3.5, 6);
  });

  it("@scenario S-R237511CO-01-utc UTC的每日费用也写明时区与美元口径", () => {
    expect(formatDailyCostScope("UTC")).toBe("按 UTC 自然日 · 美元");
  });

  it("@scenario S-R237511CO-01-utc 固定偏移不能冒充地区时区", () => {
    const supported = new Set(listDailyCostTimeZones().map((zone) => zone.id));

    expect(() => validateDailyCostSelection(
      { timeZone: "UTC-08:00", startDate: "2025-06-20", endDate: "2025-06-21" },
      supported,
    )).toThrow(DailyCostSelectionError);
  });

  it("@scenario S-R237511CO-01-dst 纽约调钟当天仍归为一个自然日", () => {
    const entries = [
      entry(1, "2025-03-09T05:30:00Z", 2),
      entry(2, "2025-03-10T03:30:00Z", 3),
      entry(3, "2025-03-08T17:00:00Z", 7),
      entry(4, "2025-03-10T16:00:00Z", 11),
    ];

    const days = aggregateDailyCosts(entries, {
      timeZone: "America/New_York",
      startDate: "2025-03-09",
      endDate: "2025-03-09",
    });

    expect(days.length).toBe(1);
    expect(days.map((day) => day.date)).toEqual(["2025-03-09"]);
    expect(days.map((day) => day.count)).toEqual([2]);
    expect(days[0]?.costUsd).toBeCloseTo(5, 6);
  });

  it("@scenario S-R237511CO-01-dst 纽约的每日费用写明时区与美元口径", () => {
    expect(formatDailyCostScope("America/New_York")).toBe("按 America/New_York 自然日 · 美元");
  });

  it("@scenario S-R237511CO-01-dst 不存在的当地日期与倒置的范围被拒绝", () => {
    const supported = new Set(listDailyCostTimeZones().map((zone) => zone.id));

    expect(() => validateDailyCostSelection(
      { timeZone: "America/New_York", startDate: "2025-02-29", endDate: "2025-03-01" },
      supported,
    )).toThrow(DailyCostSelectionError);
    expect(() => validateDailyCostSelection(
      { timeZone: "America/New_York", startDate: "2025-03-10", endDate: "2025-03-09" },
      supported,
    )).toThrow(DailyCostSelectionError);
  });
});
