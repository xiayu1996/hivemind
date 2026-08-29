import { describe, expect, it } from "vitest";
import {
  REDACTED,
  redactForExport,
  type RecordRedactor,
} from "./redact.js";

const alphaToBeta: RecordRedactor = (value) => value === "alpha" ? "beta" : value;
const betaToRedacted: RecordRedactor = (value) => value === "beta" ? REDACTED : value;

describe("redactForExport", () => {
  it("redacts credential fields recursively without changing the canonical record", () => {
    const canonical = {
      type: "request/header",
      data: {
        accessToken: "access-secret-value",
        nested: [{ refresh_token: "refresh-secret-value", apiKey: "provider-secret" }],
      },
    };
    const snapshot = structuredClone(canonical);
    const exported = redactForExport(canonical);

    expect(exported).toEqual({
      type: "request/header",
      data: { accessToken: REDACTED, nested: [{ refresh_token: REDACTED, apiKey: REDACTED }] },
    });
    expect(canonical).toEqual(snapshot);
    expect(exported).not.toBe(canonical);
  });

  it("removes JWT and common token shapes embedded in free text", () => {
    const jwt = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    const exported = redactForExport({
      message: `Authorization: Bearer ${jwt}`,
      stderr: `bad sk-${"x".repeat(24)} and ghp_${"y".repeat(36)}`,
    });
    const text = JSON.stringify(exported);
    expect(text).not.toContain("eyJ");
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("ghp_");
    expect(text).toContain(REDACTED);
  });

  it("applies deployment redactors as an ordered waterfall", () => {
    expect(redactForExport({ value: "alpha" }, [alphaToBeta, betaToRedacted])).toEqual({ value: REDACTED });
    expect(redactForExport({ value: "alpha" }, [betaToRedacted, alphaToBeta])).toEqual({ value: "beta" });
  });
});
