import { describe, expect, it } from "vitest";
import type { DesignToken } from "../pipeline/interface-contract.js";
import {
  evaluatePrototypeExit,
  PROTOTYPE_STATES,
  type PrototypeExitInput,
  type PrototypePageEvidence,
} from "./prototype-exit.js";
import type { PageStyles } from "./ui-contract.js";

const tokens: DesignToken[] = [
  { name: "color.surface", type: "color", value: "#111827" },
  { name: "size.text.body", type: "dimension", value: "1rem" },
];

const clean: PageStyles = {
  rootFontSizePx: 16,
  usages: [
    { selector: "main", property: "background-color", value: "rgb(17, 24, 39)" },
    { selector: "main > h1", property: "font-size", value: "16px" },
  ],
};

function states(snapshot: string): PrototypePageEvidence["states"] {
  return Object.fromEntries(PROTOTYPE_STATES.map((state) => [state, `${snapshot}\n- note: ${state}`]));
}

function page(file: string, snapshot: string, overrides: Partial<PrototypePageEvidence> = {}): PrototypePageEvidence {
  return { file, snapshot, states: states(snapshot), styles: clean, ...overrides };
}

function input(overrides: Partial<PrototypeExitInput> = {}): PrototypeExitInput {
  const snapshot = '- heading "任务看板" [level=1]\n- button "新建任务"';
  return {
    claims: [{
      file: "pages/board.html",
      scenarios: ["R-1-01"],
      visible: [{ role: "button", text: "新建任务" }],
    }],
    evidence: [page("pages/board.html", snapshot)],
    contractPages: ["pages/board.html"],
    scenarios: ["R-1-01"],
    tokens,
    contractReasons: [],
    ...overrides,
  };
}

describe("evaluatePrototypeExit", () => {
  it("passes a prototype that draws what it claims, in four states, out of the table", () => {
    expect(evaluatePrototypeExit(input())).toEqual([]);
  });

  it("refuses a page that claims something it did not draw", () => {
    const found = evaluatePrototypeExit(input({
      claims: [{
        file: "pages/board.html",
        scenarios: ["R-1-01"],
        visible: [{ role: "button", text: "导出报表" }],
      }],
    }));

    expect(found).toEqual(['pages/board.html 上没有出现它声称能看见的内容：button “导出报表”']);
  });

  it("refuses a scenario that no page carries, so the screens cover the requirement", () => {
    const found = evaluatePrototypeExit(input({ scenarios: ["R-1-01", "R-1-02"] }));

    expect(found).toEqual(["场景 R-1-02 没有任何一页承接"]);
  });

  it("refuses a claim on a page the contract does not hold", () => {
    const found = evaluatePrototypeExit(input({ contractPages: [] }));

    expect(found).toEqual(["页面清单里的 pages/board.html 在契约里不存在"]);
  });

  it("refuses a scenario id the requirement never had", () => {
    const found = evaluatePrototypeExit(input({
      claims: [{
        file: "pages/board.html",
        scenarios: ["R-1-01", "R-9-99"],
        visible: [{ role: "button", text: "新建任务" }],
      }],
    }));

    expect(found).toEqual(["pages/board.html 声称承接的 R-9-99 不是这条需求的场景"]);
  });

  it("refuses a state that renders nothing", () => {
    const snapshot = '- heading "任务看板" [level=1]\n- button "新建任务"';
    const partial = states(snapshot);
    delete (partial as Record<string, string>).error;
    const found = evaluatePrototypeExit(input({
      evidence: [page("pages/board.html", snapshot, { states: partial })],
    }));

    expect(found).toEqual(["pages/board.html 的 ?state=error 没有渲染出内容"]);
  });

  it("refuses four states that are the same page, because then the query does nothing", () => {
    const snapshot = '- heading "任务看板" [level=1]\n- button "新建任务"';
    const same = Object.fromEntries(PROTOTYPE_STATES.map((state) => [state, snapshot]));
    const found = evaluatePrototypeExit(input({
      evidence: [page("pages/board.html", snapshot, { states: same })],
    }));

    expect(found).toHaveLength(6);
    expect(found[0]).toBe("pages/board.html 的 ?state=empty 与 ?state=loading 画出来是同一页，四态没有真的分开");
  });

  it("refuses a colour nobody put in the token table", () => {
    const snapshot = '- heading "任务看板" [level=1]\n- button "新建任务"';
    const found = evaluatePrototypeExit(input({
      evidence: [page("pages/board.html", snapshot, {
        styles: {
          rootFontSizePx: 16,
          usages: [{ selector: "main > .card", property: "background-color", value: "rgb(200, 200, 200)" }],
        },
      })],
    }));

    expect(found).toEqual([
      "pages/board.html 的 main > .card 用了不在设计规范里的颜色：background-color 是 rgb(200, 200, 200)",
    ]);
  });

  it("says a page would not open rather than reporting everything it cannot see on it", () => {
    const found = evaluatePrototypeExit(input({
      evidence: [{ file: "pages/board.html", snapshot: null, states: {}, styles: null }],
    }));

    expect(found).toEqual(["pages/board.html 打不开，没法判断它画了什么"]);
  });

  it("passes on the contract's own reasons, so a half-written one is one round not two", () => {
    const found = evaluatePrototypeExit(input({ contractReasons: ["tokens.json is missing"] }));

    expect(found[0]).toBe("界面契约还不完整：tokens.json is missing");
  });

  it("reports the same findings in the same order however the pages were listed", () => {
    const snapshot = '- heading "任务看板" [level=1]';
    const two = {
      claims: [
        { file: "pages/b.html", scenarios: ["R-1-01"], visible: [{ role: "button", text: "缺" }] },
        { file: "pages/a.html", scenarios: ["R-1-01"], visible: [{ role: "button", text: "缺" }] },
      ],
      evidence: [page("pages/a.html", snapshot), page("pages/b.html", snapshot)],
      contractPages: ["pages/a.html", "pages/b.html"],
    };

    expect(evaluatePrototypeExit(input(two))).toEqual([
      'pages/a.html 上没有出现它声称能看见的内容：button “缺”',
      'pages/b.html 上没有出现它声称能看见的内容：button “缺”',
    ]);
  });
});
