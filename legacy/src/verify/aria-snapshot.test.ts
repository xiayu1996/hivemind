import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeMissing, missingFromSnapshot, parseAriaSnapshot } from "./aria-snapshot.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/aria-snapshots/", import.meta.url));

async function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURES, name), "utf8");
}

describe("parseAriaSnapshot", () => {
  it("reads roles, accessible names and text from a snapshot a real round captured", async () => {
    const nodes = parseAriaSnapshot(await fixture("round-detail.yml"));

    expect(nodes).toContainEqual({ role: "heading", name: "S-TRACE02-01｜逐轮执行详情", text: "" });
    expect(nodes).toContainEqual({ role: "link", name: "← 返回任务列表", text: "" });
    expect(nodes).toContainEqual({ role: "generic", name: "", text: "运行控制台" });
  });

  it("keeps a text node the capture had to quote, without its quoting", async () => {
    const nodes = parseAriaSnapshot(await fixture("route-not-found.yml"));

    expect(nodes).toEqual([{
      role: "generic",
      name: "",
      text: '{"message":"Route GET:/agent-rules not found","error":"Not Found","statusCode":404}',
    }]);
  });

  it("skips the property lines a node carries, which name no role", () => {
    const nodes = parseAriaSnapshot(['- link "home" [ref=a]:', "  - /url: /tasks"].join("\n"));

    expect(nodes).toEqual([{ role: "link", name: "home", text: "" }]);
  });
});

describe("missingFromSnapshot", () => {
  it("accepts text that is part of a longer label", async () => {
    const snapshot = await fixture("round-detail.yml");

    expect(missingFromSnapshot(snapshot, [{ role: "link", text: "返回任务列表" }])).toEqual([]);
  });

  it("accepts a requirement met by a node's text rather than its name", async () => {
    const snapshot = await fixture("round-detail.yml");

    expect(missingFromSnapshot(snapshot, [{ role: "generic", text: "运行控制台" }])).toEqual([]);
  });

  it("refuses a requirement whose role is present but whose text is elsewhere on the page", async () => {
    const snapshot = await fixture("round-detail.yml");

    expect(missingFromSnapshot(snapshot, [{ role: "heading", text: "运行控制台" }]))
      .toEqual([{ role: "heading", text: "运行控制台" }]);
  });

  it("refuses everything a page that never rendered was supposed to show", async () => {
    // The round this came from reported four scenarios passing against this
    // one page. Every requirement is missing, which is the whole finding.
    const snapshot = await fixture("route-not-found.yml");
    const required = [
      { role: "heading", text: "Agent 工作指引" },
      { role: "button", text: "保存" },
    ];

    expect(missingFromSnapshot(snapshot, required)).toEqual(required);
  });

  it("returns the requirements in the order they were declared", async () => {
    const snapshot = await fixture("round-detail.yml");
    const required = [
      { role: "button", text: "导出" },
      { role: "heading", text: "S-TRACE02-01｜逐轮执行详情" },
      { role: "button", text: "重试" },
    ];

    expect(missingFromSnapshot(snapshot, required)).toEqual([required[0], required[2]]);
  });
});

describe("describeMissing", () => {
  it("says what was not on the page in the words the card is written in", () => {
    expect(describeMissing([{ role: "heading", text: "Agent 工作指引" }]))
      .toBe("页面上没有出现这个场景声明要看见的内容：heading “Agent 工作指引”");
  });
});
