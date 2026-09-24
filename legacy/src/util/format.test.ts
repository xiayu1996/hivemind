import { describe, it, expect } from "vitest";
import { formatUsd, formatBytes } from "./format.js";

describe("formatUsd", () => {
  it("S-VAL-01-a: formats positive finite numbers with $ prefix, two decimals, thousands separators", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(1000000)).toBe("$1,000,000.00");
    expect(formatUsd(99.999)).toBe("$100.00");
  });

  it("S-VAL-01-b: formats zero as $0.00 and negative with leading minus before $", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-1234.5)).toBe("-$1,234.50");
    expect(formatUsd(-0.01)).toBe("-$0.01");
  });

  it("S-VAL-01-c: throws TypeError for NaN, Infinity, -Infinity, and non-number values", () => {
    expect(() => formatUsd(NaN)).toThrow(TypeError);
    expect(() => formatUsd(Infinity)).toThrow(TypeError);
    expect(() => formatUsd(-Infinity)).toThrow(TypeError);
    expect(() => formatUsd("123" as unknown as number)).toThrow(TypeError);
    expect(() => formatUsd(null as unknown as number)).toThrow(TypeError);
    expect(() => formatUsd(undefined as unknown as number)).toThrow(TypeError);
    expect(() => formatUsd({} as unknown as number)).toThrow(TypeError);
  });
});

describe("formatBytes", () => {
  it("S-VAL-01-d: adapts unit across B/KB/MB/GB at thresholds; B integer, KB+ two decimals", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(1048576)).toBe("1.00 MB");
    expect(formatBytes(1073741824)).toBe("1.00 GB");
  });

  it("S-VAL-01-e: values beyond GB range remain in GB without TB unit", () => {
    expect(formatBytes(2199023255552)).toBe("2048.00 GB");
  });

  it("S-VAL-01-f: throws RangeError for negative, TypeError for non-finite/non-number", () => {
    expect(() => formatBytes(-1)).toThrow(RangeError);
    expect(() => formatBytes(NaN)).toThrow(TypeError);
    expect(() => formatBytes(Infinity)).toThrow(TypeError);
    expect(() => formatBytes(-Infinity)).toThrow(TypeError);
    expect(() => formatBytes("1024" as unknown as number)).toThrow(TypeError);
    expect(() => formatBytes(null as unknown as number)).toThrow(TypeError);
    expect(() => formatBytes(undefined as unknown as number)).toThrow(TypeError);
  });
});
