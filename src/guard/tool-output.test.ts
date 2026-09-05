import { describe, expect, it } from "vitest";
import { PI_DEFAULT_TOOL_OUTPUT_LIMITS, toolOutputLimitsFor, truncateToolResult } from "./tool-output.js";

describe("toolOutputLimitsFor", () => {
  it("caps exploration phases well below pi's built-in limit", () => {
    for (const phase of ["DECOMPOSE", "DESIGN"] as const) {
      const limits = toolOutputLimitsFor(phase);
      expect(limits.maxBytes).toBeLessThan(PI_DEFAULT_TOOL_OUTPUT_LIMITS.maxBytes);
      expect(limits.maxLines).toBeLessThan(PI_DEFAULT_TOOL_OUTPUT_LIMITS.maxLines);
    }
  });

  it("leaves phases that need complete test output at pi's default", () => {
    for (const phase of ["CODE", "VERIFY", "REGRESSION_FIX", "E2E", "MERGE"] as const) {
      expect(toolOutputLimitsFor(phase)).toEqual(PI_DEFAULT_TOOL_OUTPUT_LIMITS);
    }
  });
});

describe("truncateToolResult", () => {
  const limits = { maxBytes: 100, maxLines: 5 };

  it("returns content untouched when it is within both limits", () => {
    const content = [{ type: "text", text: "a\nb\nc" }];
    const result = truncateToolResult(content, limits);
    expect(result.truncated).toBe(false);
    expect(result.content).toEqual(content);
  });

  it("keeps the head and reports the total when the line limit is exceeded", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = truncateToolResult([{ type: "text", text }], limits);
    expect(result.truncated).toBe(true);
    const output = result.content[0]!.text!;
    expect(output.startsWith("line 1\nline 2\nline 3\nline 4\nline 5\n\n[hivemind: output truncated")).toBe(true);
    expect(output).toContain("12 lines total");
    expect(output).not.toContain("line 6");
  });

  it("cuts on the byte limit without leaving a broken multi-byte character", () => {
    const text = "日本語テキスト".repeat(20);
    const result = truncateToolResult([{ type: "text", text }], { maxBytes: 50, maxLines: 100 });
    const kept = result.content[0]!.text!.split("\n\n[hivemind")[0]!;
    expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(50);
    expect(kept).not.toContain("�");
    expect(text.startsWith(kept)).toBe(true);
  });

  it("leaves non-text blocks alone", () => {
    const image = { type: "image", data: "x".repeat(1000) } as { type: string; text?: string };
    const result = truncateToolResult([image], limits);
    expect(result.truncated).toBe(false);
    expect(result.content[0]).toBe(image);
  });
});
