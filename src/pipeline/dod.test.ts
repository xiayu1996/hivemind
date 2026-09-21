import { describe, expect, it } from "vitest";
import {
  DoDValidationError,
  LAYER_OWNER,
  hasScreen,
  lintDoDLanguage,
  parseDoD,
  refusableStatements,
  footprintWithoutGround,
  renderFootprintWithoutGround,
  renderMissingPage,
  renderMissingVisible,
  renderDoDLanguageFindings,
  scanScenarioCoverage,
  scenariosMissingPage,
  structuralRequirements,
  scenariosMissingVisible,
  scenarioTitle,
  seedOf,
} from "./dod.js";

const yaml = `
story_id: S-EPIC12-03
design_summary: Deduct the coupon before tax.
scenarios:
  - id: S-EPIC12-03-a
    given: A taxable cart
    when: A flat coupon is applied
    then: Tax uses the discounted subtotal
    layers: [unit, integration]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: Tax is calculated from the discounted subtotal
    scenarios: [S-EPIC12-03-a]
  - text: The cart page stays read-only
    constraint: the guard policy denies write tools in VERIFY
out_of_scope: []
relies_on: []
predicted_footprint: [src/cart]
depends_on: []
`;

describe("parseDoD", () => {
  it("parses the complete YAML contract", () => {
    const dod = parseDoD(yaml);
    expect(dod.story_id).toBe("S-EPIC12-03");
    expect(dod.scenarios[0]?.layers).toEqual(["unit", "integration"]);
  });

  it("rejects a non-global scenario id and duplicate ids", () => {
    expect(() => parseDoD(yaml.replace("S-EPIC12-03-a", "scenario-1"))).toThrow(DoDValidationError);
    const duplicate = yaml.replace("baseline:", `  - id: S-EPIC12-03-a
    given: Other
    when: Other
    then: Other
    layers: [unit]
baseline:`);
    expect(() => parseDoD(duplicate)).toThrow(/duplicate scenario id/);
  });

  it("rejects a criterion with no scenario and no constraint, or naming an undeclared scenario", () => {
    const orphan = yaml.replace("    scenarios: [S-EPIC12-03-a]\n", "");
    expect(() => parseDoD(orphan)).toThrow(DoDValidationError);
    const undeclared = yaml.replace("scenarios: [S-EPIC12-03-a]", "scenarios: [S-EPIC12-03-zz]");
    expect(() => parseDoD(undeclared)).toThrow(/undeclared scenario S-EPIC12-03-zz/);
  });

  it("requires a shows and an excludes example plus a source for any scenario judged on a screen", () => {
    const onScreen = yaml.replace("layers: [unit, integration]", "layers: [unit, ui]");
    expect(() => parseDoD(onScreen)).toThrow(/needs at least one "shows" and one "excludes" example/);
    expect(() => parseDoD(onScreen)).toThrow(/needs a source/);
    const complete = onScreen.replace("layers: [unit, ui]", `layers: [unit, ui]
    source: carts.discounted_subtotal
    examples:
      - kind: shows
        text: "Tax: $8.10 on $90.00"
      - kind: excludes
        text: "Tax: $9.00 on $100.00"`);
    const dod = parseDoD(complete);
    expect(hasScreen(dod.scenarios[0]!)).toBe(true);
    expect(refusableStatements(dod.scenarios[0]!)).toEqual([
      "Tax uses the discounted subtotal",
      "Tax: $8.10 on $90.00",
      "Tax: $9.00 on $100.00",
    ]);
    expect(LAYER_OWNER.ui).toBe("verify");
    expect(LAYER_OWNER.unit).toBe("code");
  });

  it("carries the sample data a screen scenario asks for, and leaves it optional", () => {
    const dod = parseDoD(yaml.replace("    layers: [unit, integration]\n", "    layers: [unit, integration]\n    seed: one cart with two taxable items\n"));
    expect(seedOf(dod.scenarios[0]!)).toBe("one cart with two taxable items");
    expect(seedOf(parseDoD(yaml).scenarios[0]!)).toBeUndefined();
  });

  it("requires a reason when a test baseline is exempt", () => {
    const exempt = yaml.replace("type: acceptance_test", "type: exempt");
    expect(() => parseDoD(exempt)).toThrow(DoDValidationError);
    expect(() => parseDoD(exempt.replace("type: exempt", "type: exempt\n  reason: External certification"))).not.toThrow();
  });
});

describe("scanScenarioCoverage", () => {
  it("fails closed when a DoD scenario has no test marker", () => {
    const result = scanScenarioCoverage(parseDoD(yaml), [
      { path: "cart.test.ts", content: "test('tax', () => {})" },
    ]);
    expect(result).toEqual({ pass: false, missing: ["S-EPIC12-03-a"], unexpected: [] });
  });

  it("accepts markers and reports markers not declared by the DoD", () => {
    const result = scanScenarioCoverage(parseDoD(yaml), [
      { path: "cart.test.ts", content: "// @scenario S-EPIC12-03-a\n// @scenario S-EPIC12-99-z" },
    ]);
    expect(result).toEqual({ pass: false, missing: [], unexpected: ["S-EPIC12-99-z"] });
  });
});

describe("the language a DoD is written in", () => {
  const chinese = `
story_id: S-EPIC12-03
design_summary: 结账时先减掉优惠券再算税，用户看到的总价比原来低。
scenarios:
  - id: S-EPIC12-03-a
    title: 用券后按折后价算税
    given: 购物车里有要算税的商品
    when: 用掉一张满减券
    then: 税按折后金额算，页面上的总价随之变小
    layers: [unit, integration]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: 税按折后金额算
    scenarios: [S-EPIC12-03-a]
out_of_scope: []
relies_on: []
predicted_footprint: [src/cart]
depends_on: []
`;

  it("accepts a DoD written for the person who ordered the card", () => {
    expect(lintDoDLanguage(parseDoD(chinese))).toEqual([]);
    expect(parseDoD(chinese).scenarios[0]?.title).toBe("用券后按折后价算税");
  });

  it("names the sentence to rewrite when the DoD came back in English", () => {
    const findings = lintDoDLanguage(parseDoD(yaml));
    expect(findings.map((finding) => finding.where)).toContain("design_summary");
    expect(findings.some((finding) => finding.where.endsWith(".title") && finding.what === "is missing")).toBe(true);
    expect(renderDoDLanguageFindings(findings)).toContain("scenarios.S-EPIC12-03-a.given");
  });

  it("numbers a scenario a DoD frozen before titles existed, rather than inventing a name for it", () => {
    const scenario = parseDoD(yaml).scenarios[0]!;
    expect(scenarioTitle(scenario, 1)).toBe("场景 1");
    expect(scenarioTitle({ title: "用券后按折后价算税" }, 1)).toBe("用券后按折后价算税");
  });

  it("refuses a title longer than a line a person skims", () => {
    const long = chinese.replace("title: 用券后按折后价算税", `title: ${"很长".repeat(11)}`);
    expect(() => parseDoD(long)).toThrow(DoDValidationError);
  });
});

describe("what a screen scenario says a person will see", () => {
  // A screen scenario already owes examples and a source, so the fixture has
  // to satisfy those before the missing declaration is what fails.
  const screen = [
    "    layers: [ui]",
    "    source: the stories table",
    "    examples:",
    "      - kind: shows",
    "        text: 运行控制台",
    "      - kind: excludes",
    "        text: 还没有任何任务",
  ].join("\n");
  const withScreen = (extra = ""): string =>
    yaml.replace("    layers: [unit, integration]", `${screen}${extra}`);

  it("asks a scenario a browser settles for the roles and text it will show", () => {
    expect(scenariosMissingVisible(parseDoD(withScreen()))).toEqual(["S-EPIC12-03-a"]);
  });

  it("asks nothing of a scenario a test runner settles", () => {
    expect(scenariosMissingVisible(parseDoD(yaml))).toEqual([]);
  });

  it("is satisfied once the scenario declares them", () => {
    const declared = withScreen("\n    visible:\n      - role: heading\n        text: 运行控制台");
    const dod = parseDoD(declared);

    expect(dod.scenarios[0]?.visible).toEqual([{ role: "heading", text: "运行控制台" }]);
    expect(scenariosMissingVisible(dod)).toEqual([]);
  });

  it("names every scenario still missing them, so one round closes them all", () => {
    expect(renderMissingVisible(["S-A-01-a", "S-A-01-b"])).toContain("- S-A-01-a\n- S-A-01-b");
  });
});

describe("what the structural layer compares against", () => {
  const screen = [
    "    layers: [ui]",
    "    source: the stories table",
    "    page: /tasks",
    "    examples:",
    "      - kind: shows",
    "        text: 运行控制台",
    "      - kind: excludes",
    "        text: 还没有任何任务",
    "    visible:",
    "      - role: heading",
    "        text: 运行控制台",
  ].join("\n");

  it("takes the roles a screen scenario promised", () => {
    const dod = parseDoD(yaml.replace("    layers: [unit, integration]", screen));

    expect(structuralRequirements(dod).get("S-EPIC12-03-a")).toEqual([{ role: "heading", text: "运行控制台" }]);
  });

  it("asks nothing of a scenario whose given a browser could not build, once it moved to the code layers", () => {
    // What an operator leaves behind when a screen scenario turns out to be
    // unprovable in a browser: the layer changes, the promise it once made
    // stays written down.
    const moved = yaml.replace("    layers: [unit, integration]", screen.replace("    layers: [ui]", "    layers: [integration]"));

    expect(structuralRequirements(parseDoD(moved)).size).toBe(0);
  });
});

describe("where a screen scenario is served", () => {
  const screen = [
    "    layers: [ui]",
    "    source: the stories table",
    "    examples:",
    "      - kind: shows",
    "        text: 运行控制台",
    "      - kind: excludes",
    "        text: 还没有任何任务",
  ].join("\n");
  const withScreen = (extra = ""): string =>
    yaml.replace("    layers: [unit, integration]", `${screen}${extra}`);

  it("asks a scenario a browser settles where its page is", () => {
    expect(scenariosMissingPage(parseDoD(withScreen()))).toEqual(["S-EPIC12-03-a"]);
  });

  it("asks nothing of a scenario a test runner settles", () => {
    expect(scenariosMissingPage(parseDoD(yaml))).toEqual([]);
  });

  it("is satisfied once the scenario names the path", () => {
    const dod = parseDoD(withScreen("\n    page: /operator/costs"));

    expect(dod.scenarios[0]?.page).toBe("/operator/costs");
    expect(scenariosMissingPage(dod)).toEqual([]);
  });

  it("refuses anything that is not an application path", () => {
    expect(() => parseDoD(withScreen("\n    page: http://localhost:4319/operator/costs")))
      .toThrow(/page must be an application path/);
    expect(() => parseDoD(withScreen("\n    page: operator/costs")))
      .toThrow(/page must be an application path/);
  });

  it("names every scenario still missing one, so one round closes them all", () => {
    expect(renderMissingPage(["S-A-01-a", "S-A-01-b"])).toContain("- S-A-01-a\n- S-A-01-b");
  });
});

describe("a footprint the repository has no room for", () => {
  const withFootprint = (entries: string[]) =>
    parseDoD(yaml.replace("predicted_footprint: [src/cart]", `predicted_footprint: [${entries.join(", ")}]`));

  // The tree S-R237511MB-02 actually ran on.
  const tree = new Set(["src", "src/console", "src/config", "console-ui", "console-ui/src", "console-ui/src/pages", "scripts", "scripts/serve-console.ts"]);
  const exists = (path: string) => tree.has(path);

  it("refuses an entry whose only ancestor is the repository root", () => {
    expect(footprintWithoutGround(withFootprint(["console/"]), exists)).toEqual(["console/"]);
  });

  it("accepts a directory the card is about to create under one that exists", () => {
    expect(footprintWithoutGround(withFootprint(["console-ui/src/pages/records"]), exists)).toEqual([]);
  });

  it("accepts the spellings the scheduler widens, and a file", () => {
    const dod = withFootprint(["src/console/**", "src/console/", "scripts/serve-console.ts"]);
    expect(footprintWithoutGround(dod, exists)).toEqual([]);
  });

  it("names every entry it refused, in the words they were written in", () => {
    expect(renderFootprintWithoutGround(["console/", "web"])).toContain("- console/");
    expect(renderFootprintWithoutGround(["console/", "web"])).toContain("- web");
  });
});
