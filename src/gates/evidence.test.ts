import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchAnySnapshot, matchOutput, matchVisible, parseAriaSnapshot } from "./evidence.ts";

/** A round-detail page of the run console, as a real verification round captured it. */
const ROUND_DETAIL = String.raw`- generic [ref=f3e2]:
  - banner [ref=f3e3]:
    - link "hivemind" [ref=f3e4] [cursor=pointer]:
      - /url: /tasks
    - generic [ref=f3e5]: 运行控制台
  - main [ref=f3e6]:
    - link "← 返回任务列表" [ref=f3e7] [cursor=pointer]:
      - /url: /tasks
    - heading "S-TRACE02-01｜逐轮执行详情" [level=1] [ref=f3e8]
    - list [ref=f3e9]:
      - listitem [ref=f3e10]:
        - generic [ref=f3e11]:
          - heading "第 1 轮" [level=2] [ref=f3e12]
          - generic [ref=f3e13]: 已完成
        - generic [ref=f3e14]:
          - heading "执行过程" [level=3] [ref=f3e15]
          - list [ref=f3e16]:
            - listitem [ref=f3e17]: CODE第 1 轮实现已经完成
            - listitem [ref=f3e18]: VERIFY第 1 轮验收通过
        - generic [ref=f3e19]:
          - heading "产出" [level=3] [ref=f3e20]
          - list [ref=f3e21]:
            - listitem [ref=f3e22]: CODE第 1 轮实现已经完成
            - listitem [ref=f3e23]: VERIFY第 1 轮验收通过
        - generic [ref=f3e24]:
          - heading "当前结果" [level=3] [ref=f3e25]
          - paragraph [ref=f3e26]: accepted
      - listitem [ref=f3e27]:
        - generic [ref=f3e28]:
          - heading "第 2 轮" [level=2] [ref=f3e29]
          - generic [ref=f3e30]: 执行失败
        - generic [ref=f3e31]:
          - heading "执行过程" [level=3] [ref=f3e32]
          - list [ref=f3e33]:
            - listitem [ref=f3e34]: "VERIFY{\"verdict\":\"rejected\",\"failedScenarios\":[\"S-TRACE02-01-navigation\"],\"reasons\":[{\"scenarioId\":\"S-TRACE02-01-navigation\",\"reason\":\"详情里混进了另一项任务的记录\"}],\"validationErrors\":[]}"
        - generic [ref=f3e35]:
          - heading "产出" [level=3] [ref=f3e36]
          - list [ref=f3e37]:
            - listitem [ref=f3e38]: VERIFY第 2 轮验收没有通过
            - listitem [ref=f3e39]: "VERIFY{\"verdict\":\"rejected\",\"failedScenarios\":[\"S-TRACE02-01-navigation\"],\"reasons\":[{\"scenarioId\":\"S-TRACE02-01-navigation\",\"reason\":\"详情里混进了另一项任务的记录\"}],\"validationErrors\":[]}"
        - generic [ref=f3e40]:
          - heading "当前结果" [level=3] [ref=f3e41]
          - paragraph [ref=f3e42]: 详情里混进了另一项任务的记录
        - paragraph [ref=f3e43]: 失败原因：详情里混进了另一项任务的记录
      - listitem [ref=f3e44]:
        - generic [ref=f3e45]:
          - heading "第 3 轮" [level=2] [ref=f3e46]
          - generic [ref=f3e47]: 正在进行
        - generic [ref=f3e48]:
          - heading "执行过程" [level=3] [ref=f3e49]
          - list [ref=f3e50]:
            - listitem [ref=f3e51]: CODE正在准备第 3 轮的验收证据
        - generic [ref=f3e52]:
          - heading "产出" [level=3] [ref=f3e53]
          - list [ref=f3e54]:
            - listitem [ref=f3e55]: CODE正在准备第 3 轮的验收证据
        - generic [ref=f3e56]:
          - heading "当前结果" [level=3] [ref=f3e57]
          - paragraph [ref=f3e58]: 正在准备第 3 轮的验收证据`;

/** A round whose page never rendered: the server's 404 body was all there was. */
const ROUTE_NOT_FOUND = String.raw`- generic [active] [ref=e1]: "{\"message\":\"Route GET:/agent-rules not found\",\"error\":\"Not Found\",\"statusCode\":404}"`;

/** Lines Playwright 1.63 wrote for names and texts that YAML would otherwise misread. */
const QUOTED_FORMS = String.raw`- main [ref=e4]:
  - 'heading "Step 1: Configure" [level=2] [ref=e7]'
  - 'heading "Issue #42" [level=3] [ref=e9]'
  - paragraph [ref=e10]: "42"
  - paragraph [ref=e11]: ~
  - paragraph [ref=e12]: .inf
  - link /tasks/ [ref=e18] [cursor=pointer]:
    - /url: /x/
  - 'textbox "Note: x"': "yes"
  - heading "A \"quoted\" \\ name" [level=2]
  - 'button "Say \"hi\": now"': x
  - 'button "Don''t: stop" [ref=e28]'
  - paragraph: "esc\x1b[32mgreen\x07bell"
  - paragraph`;

const PAGE_A = [
  "- main [ref=e1]:",
  '  - heading "运行控制台" [level=1] [ref=e2]',
  '  - button "导出" [ref=e3]',
].join("\n");

const PAGE_B = [
  "- main [ref=e1]:",
  '  - heading "任务列表" [level=1] [ref=e2]',
  '  - button "导出" [ref=e3]',
].join("\n");

describe("parseAriaSnapshot", () => {
  it("reads roles, accessible names and text from a snapshot a real round captured", () => {
    const nodes = parseAriaSnapshot(ROUND_DETAIL);

    expect(nodes).toContainEqual({ role: "heading", name: "S-TRACE02-01｜逐轮执行详情", text: "" });
    expect(nodes).toContainEqual({ role: "link", name: "← 返回任务列表", text: "" });
    expect(nodes).toContainEqual({ role: "generic", name: "", text: "运行控制台" });
    expect(nodes).toContainEqual({ role: "paragraph", name: "", text: "accepted" });
  });

  it("keeps a text node the capture had to quote, without its quoting", () => {
    expect(parseAriaSnapshot(ROUTE_NOT_FOUND)).toEqual([{
      role: "generic",
      name: "",
      text: '{"message":"Route GET:/agent-rules not found","error":"Not Found","statusCode":404}',
    }]);
  });

  it("skips the property lines a node carries, which name no role", () => {
    const nodes = parseAriaSnapshot(['- link "home" [ref=a]:', "  - /url: /tasks"].join("\n"));

    expect(nodes).toEqual([{ role: "link", name: "home", text: "" }]);
  });

  it("reads every form Playwright uses for names and texts YAML would otherwise misread", () => {
    expect(parseAriaSnapshot(QUOTED_FORMS)).toEqual([
      { role: "main", name: "", text: "" },
      { role: "heading", name: "Step 1: Configure", text: "" },
      { role: "heading", name: "Issue #42", text: "" },
      { role: "paragraph", name: "", text: "42" },
      { role: "paragraph", name: "", text: "~" },
      { role: "paragraph", name: "", text: ".inf" },
      { role: "link", name: "/tasks/", text: "" },
      { role: "textbox", name: "Note: x", text: "yes" },
      { role: "heading", name: 'A "quoted" \\ name', text: "" },
      { role: "button", name: 'Say "hi": now', text: "x" },
      { role: "button", name: "Don't: stop", text: "" },
      { role: "paragraph", name: "", text: "esc\u001b[32mgreen\u0007bell" },
      { role: "paragraph", name: "", text: "" },
    ]);
  });

  it("keeps the nodes before the point where a truncated capture was cut", () => {
    const cut = [
      '- heading "运行控制台" [level=1]',
      String.raw`- listitem: "VERIFY{\"verdict\":\"rej`,
      '- heading "S-TRACE02-01｜逐轮',
    ].join("\n");

    expect(parseAriaSnapshot(cut)).toEqual([
      { role: "heading", name: "运行控制台", text: "" },
      { role: "listitem", name: "", text: String.raw`"VERIFY{\"verdict\":\"rej` },
    ]);
  });

  it("yields no nodes from input that is not a snapshot, and never throws", () => {
    for (const input of ["", "-", "- ", "not a snapshot", '{"heading": "x"}', "---\n- : x\n- 'unclosed", "\u0000\u0001�"]) {
      expect(parseAriaSnapshot(input)).toEqual([]);
    }
  });
});

describe("matchVisible", () => {
  it("accepts text that is part of a longer label", () => {
    expect(matchVisible(ROUND_DETAIL, [{ role: "link", text: "返回任务列表" }])).toEqual({ ok: true, missing: [] });
  });

  it("accepts an expectation met by a node's text rather than its name", () => {
    expect(matchVisible(ROUND_DETAIL, [{ role: "generic", text: "运行控制台" }]).ok).toBe(true);
  });

  it("refuses an expectation whose role is present but whose text is elsewhere on the page", () => {
    expect(matchVisible(ROUND_DETAIL, [{ role: "heading", text: "运行控制台" }]))
      .toEqual({ ok: false, missing: [{ role: "heading", text: "运行控制台" }] });
  });

  it("refuses everything a page that never rendered was supposed to show", () => {
    // The round this came from reported four scenarios passing against this
    // one page. Every expectation is missing, which is the whole finding.
    const expected = [{ role: "heading", text: "Agent 工作指引" }, { role: "button", text: "保存" }];

    expect(matchVisible(ROUTE_NOT_FOUND, expected)).toEqual({ ok: false, missing: expected });
  });

  it("returns the missing expectations in the order they were declared", () => {
    const expected = [
      { role: "button", text: "导出" },
      { role: "heading", text: "S-TRACE02-01｜逐轮执行详情" },
      { role: "button", text: "重试" },
    ];

    expect(matchVisible(ROUND_DETAIL, expected).missing).toEqual([expected[0], expected[2]]);
  });

  it("ignores case in the role and case and spacing in the text", () => {
    expect(matchVisible(QUOTED_FORMS, [{ role: "HEADING", text: "  step 1:\n configure " }]).ok).toBe(true);
  });

  it("lets an expectation without a role be met by any node, and one without a text by any node of its role", () => {
    expect(matchVisible(ROUND_DETAIL, [{ text: "运行控制台" }, { role: "list" }]).ok).toBe(true);
    expect(matchVisible(ROUND_DETAIL, [{ role: "button" }]).ok).toBe(false);
  });

  it("refuses an expectation that asks for nothing", () => {
    const expected = [{}, { role: " ", text: "" }];

    expect(matchVisible(ROUND_DETAIL, expected)).toEqual({ ok: false, missing: expected });
  });

  it("passes a scenario that declared nothing to see", () => {
    expect(matchVisible(ROUTE_NOT_FOUND, [])).toEqual({ ok: true, missing: [] });
  });
});

describe("matchAnySnapshot", () => {
  it("passes when one snapshot shows every expectation", () => {
    const expected = [{ role: "heading", text: "运行控制台" }, { role: "button", text: "导出" }];

    expect(matchAnySnapshot([PAGE_B, PAGE_A], expected)).toEqual({ ok: true, missing: [] });
  });

  it("refuses expectations split across two pages", () => {
    // Both texts are in the evidence, one per page. A person never saw them
    // together, so the scenario has not been shown.
    const expected = [{ role: "heading", text: "运行控制台" }, { role: "heading", text: "任务列表" }];

    expect(matchAnySnapshot([PAGE_A, PAGE_B], expected).ok).toBe(false);
  });

  it("reports the smallest gap when no single page shows everything", () => {
    const expected = [
      { role: "heading", text: "运行控制台" },
      { role: "button", text: "导出" },
      { role: "button", text: "重试" },
    ];

    // PAGE_A misses one expectation and PAGE_B two; the gap reported is the
    // one a person would actually have to close.
    expect(matchAnySnapshot([PAGE_B, PAGE_A], expected).missing).toEqual([{ role: "button", text: "重试" }]);
  });

  it("misses every expectation when there is no snapshot at all", () => {
    const expected = [{ role: "heading", text: "运行控制台" }];

    expect(matchAnySnapshot([], expected)).toEqual({ ok: false, missing: expected });
    expect(matchAnySnapshot([], [])).toEqual({ ok: true, missing: [] });
  });
});

describe("matchOutput", () => {
  const output = "Tasks\n  ID    TITLE\n  1     导出  报表\n\u001b[32m3 passed\u001b[39m (12 ms)\n";

  it("finds each expected text in the output, ignoring case, spacing and color codes", () => {
    expect(matchOutput(output, [{ text: "tasks id title" }, { text: "导出 报表" }, { text: "3 passed" }]))
      .toEqual({ ok: true, missing: [] });
  });

  it("returns the texts that are not in the output, in the order they were declared", () => {
    const expected = [{ text: "4 failed" }, { text: "3 passed" }, { text: "重试" }];

    expect(matchOutput(output, expected).missing).toEqual([expected[0], expected[2]]);
  });

  it("ignores a role and misses an expectation that has no text to find", () => {
    const expected = [{ role: "button", text: "3 passed" }, { role: "heading" }];

    expect(matchOutput(output, expected).missing).toEqual([expected[1]]);
  });
});

describe("a snapshot the installed Playwright captured", () => {
  const html = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>任务</title></head><body>',
    '<header><a href="/tasks">← 返回任务列表</a></header>',
    "<main><h1>Step 1: Configure</h1><p>42</p><button>保存</button><ul><li>第一项</li></ul></main>",
    "</body></html>",
  ].join("\n");
  let directory: string | undefined;
  let browser: Browser | undefined;
  let snapshot = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "evidence-"));
    const file = join(directory, "page.html");
    await writeFile(file, html);
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(pathToFileURL(file).href);
    snapshot = await page.locator("body").ariaSnapshot();
  });

  afterAll(async () => {
    await browser?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("parses the key Playwright had to quote", () => {
    expect(snapshot).toContain(`'heading "Step 1: Configure" [level=1]'`);
    expect(parseAriaSnapshot(snapshot)).toContainEqual({ role: "heading", name: "Step 1: Configure", text: "" });
  });

  it("finds what the page shows and misses what it does not", () => {
    const shown = [
      { role: "heading", text: "Step 1: Configure" },
      { role: "link", text: "返回任务列表" },
      { role: "button", text: "保存" },
      { role: "listitem", text: "第一项" },
      { text: "42" },
    ];
    const absent = [{ role: "heading", text: "保存" }, { role: "button", text: "删除" }];

    expect(matchVisible(snapshot, shown)).toEqual({ ok: true, missing: [] });
    expect(matchVisible(snapshot, [...shown, ...absent])).toEqual({ ok: false, missing: absent });
  });
});
