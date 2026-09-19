import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkStructuralLayer } from "./structural-layer.js";

const PAGE = [
  '- main [ref=e1]:',
  '  - heading "运行控制台" [level=1] [ref=e2]',
  '  - button "导出" [ref=e3]',
].join("\n");

const OTHER_PAGE = [
  '- main [ref=e1]:',
  '  - heading "任务列表" [level=1] [ref=e2]',
  '  - button "导出" [ref=e3]',
].join("\n");

describe("checkStructuralLayer", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "structural-"));
    await writeFile(join(root, "page-a.yml"), PAGE);
    await writeFile(join(root, "page-b.yml"), OTHER_PAGE);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("passes a subject whose snapshot carries every role and text it declared", async () => {
    const findings = await checkStructuralLayer({
      root,
      subjects: [{
        id: "S-X-01-console",
        snapshots: ["page-a.yml"],
        required: [{ role: "heading", text: "运行控制台" }, { role: "button", text: "导出" }],
      }],
    });

    expect(findings).toEqual([]);
  });

  it("says nothing about a subject that declared nothing to see", async () => {
    const findings = await checkStructuralLayer({
      root,
      subjects: [{ id: "S-X-01-unit", snapshots: [], required: [] }],
    });

    expect(findings).toEqual([]);
  });

  it("refuses a subject that split its requirements across two pages", async () => {
    // Both texts exist in the evidence, one per page. A person never saw them
    // together, so the subject has not been shown.
    const findings = await checkStructuralLayer({
      root,
      subjects: [{
        id: "S-X-01-both",
        snapshots: ["page-a.yml", "page-b.yml"],
        required: [{ role: "heading", text: "运行控制台" }, { role: "heading", text: "任务列表" }],
      }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("S-X-01-both");
  });

  it("reports the smallest gap when no single page satisfied everything", async () => {
    const findings = await checkStructuralLayer({
      root,
      subjects: [{
        id: "S-X-01-gap",
        snapshots: ["page-b.yml", "page-a.yml"],
        required: [
          { role: "heading", text: "运行控制台" },
          { role: "button", text: "导出" },
          { role: "button", text: "重试" },
        ],
      }],
    });

    // page-a misses one requirement, page-b misses two; the reported gap is
    // the one a person would actually have to close.
    expect(findings[0]?.reason).toBe("页面上没有出现这个场景声明要看见的内容：button “重试”");
  });

  it("refuses a subject with requirements and no snapshot at all", async () => {
    const findings = await checkStructuralLayer({
      root,
      subjects: [{ id: "S-X-01-none", snapshots: [], required: [{ role: "heading", text: "运行控制台" }] }],
    });

    expect(findings[0]?.detail).toBe("no accessibility snapshot was declared");
  });

  it("refuses a snapshot that points outside the evidence root", async () => {
    const findings = await checkStructuralLayer({
      root,
      subjects: [{
        id: "S-X-01-escape",
        snapshots: ["../elsewhere.yml"],
        required: [{ role: "heading", text: "运行控制台" }],
      }],
    });

    expect(findings[0]?.detail).toContain("unreadable snapshots");
  });

  it("refuses a snapshot that is named but was never written", async () => {
    const findings = await checkStructuralLayer({
      root,
      subjects: [{
        id: "S-X-01-absent",
        snapshots: ["page-missing.yml"],
        required: [{ role: "heading", text: "运行控制台" }],
      }],
    });

    expect(findings[0]?.detail).toBe("unreadable snapshots: page-missing.yml");
  });
});

describe("checkStructuralLayer evidence", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "structural-evidence-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("marks a subject with nothing to read as the run's own gap, not the page's", async () => {
    const findings = await checkStructuralLayer({
      root,
      subjects: [
        { id: "none", snapshots: [], required: [{ role: "heading", text: "\u8fd0\u884c\u603b\u89c8" }] },
        { id: "unreadable", snapshots: ["gone.yml"], required: [{ role: "heading", text: "\u8fd0\u884c\u603b\u89c8" }] },
      ],
    });

    expect(findings.map((finding) => [finding.id, finding.evidenceMissing])).toEqual([
      ["none", true],
      ["unreadable", true],
    ]);
  });

  it("leaves a finding about the page itself unmarked", async () => {
    await writeFile(join(root, "page.yml"), '- main [ref=e1]:\n  - heading "\u4efb\u52a1\u5217\u8868" [level=1] [ref=e2]');
    const findings = await checkStructuralLayer({
      root,
      subjects: [{ id: "missing-text", snapshots: ["page.yml"], required: [{ role: "heading", text: "\u8fd0\u884c\u603b\u89c8" }] }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidenceMissing).toBeUndefined();
  });
});
