import { describe, expect, it } from "vitest";
import { probeScreens, renderUnreachableScreens, screenPages, type ScreenResponse } from "./screen-reachability.js";
import { parseDoD } from "./dod.js";

const PAGES = [
  { scenarioId: "S-A-01-costs", page: "/operator/costs" },
  { scenarioId: "S-A-01-roles", page: "/operator/roles" },
];

function answering(byUrl: Record<string, ScreenResponse>) {
  return async (url: string): Promise<ScreenResponse> => byUrl[url] ?? { status: 200 };
}

describe("opening the screens a card promises", () => {
  it("refuses a page the application does not serve", async () => {
    const unreachable = await probeScreens("http://127.0.0.1:41931/health", PAGES, answering({
      "http://127.0.0.1:41931/operator/roles": { status: 404 },
    }));

    expect(unreachable).toEqual([
      { scenarioId: "S-A-01-roles", page: "/operator/roles", reason: "应用回了「找不到页面」（HTTP 404）" },
    ]);
  });

  it("refuses a page nothing answered for", async () => {
    const unreachable = await probeScreens("http://127.0.0.1:41931/", PAGES, answering({
      "http://127.0.0.1:41931/operator/costs": { failed: "fetch failed" },
    }));

    expect(unreachable.map((entry) => entry.scenarioId)).toEqual(["S-A-01-costs"]);
    expect(unreachable[0]?.reason).toContain("fetch failed");
  });

  it("asks only whether the route is mounted, not whether a person is signed in", async () => {
    const unreachable = await probeScreens("http://127.0.0.1:41931/", PAGES, answering({
      "http://127.0.0.1:41931/operator/costs": { status: 302 },
      "http://127.0.0.1:41931/operator/roles": { status: 500 },
    }));

    expect(unreachable).toEqual([]);
  });

  it("names every unreachable screen, so one handback closes them all", () => {
    const rendered = renderUnreachableScreens([
      { scenarioId: "S-A-01-costs", page: "/operator/costs", reason: "应用回了「找不到页面」（HTTP 404）" },
      { scenarioId: "S-A-01-roles", page: "/operator/roles", reason: "应用回了「找不到页面」（HTTP 404）" },
    ]);

    expect(rendered).toContain("- S-A-01-costs /operator/costs");
    expect(rendered).toContain("- S-A-01-roles /operator/roles");
  });
});

describe("which screens a DoD promises", () => {
  const dod = [
    "story_id: S-EPIC12-03",
    "design_summary: 把运行情况摆到一页上。",
    "scenarios:",
    "  - id: S-EPIC12-03-b",
    "    title: 打开费用页看到金额",
    "    given: 已经花过钱",
    "    when: 打开费用页",
    "    then: 看到这个月的金额",
    "    layers: [ui]",
    "    source: the costs table",
    "    page: /operator/costs",
    "    examples:",
    "      - kind: shows",
    "        text: 本月花费",
    "      - kind: excludes",
    "        text: 还没有任何花费",
    "    visible:",
    "      - role: heading",
    "        text: 本月花费",
    "  - id: S-EPIC12-03-a",
    "    given: 一个阶段已经做完",
    "    when: 下一个阶段开始",
    "    then: 读得到上一个阶段留下的东西",
    "    layers: [integration]",
    "baseline:",
    "  type: acceptance_test",
    "acceptance_criteria:",
    "  - text: 费用页上能看到本月花费",
    "    scenarios: [S-EPIC12-03-b]",
    "out_of_scope: []",
    "relies_on: []",
    "predicted_footprint: [src/console]",
    "depends_on: []",
  ].join("\n");

  it("takes the screen scenarios in a stable order and leaves the others alone", () => {
    expect(screenPages(parseDoD(dod))).toEqual([
      { scenarioId: "S-EPIC12-03-b", page: "/operator/costs" },
    ]);
  });
});
