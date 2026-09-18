import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";
import {
  STORY_DETAIL_COPY,
  formatRoundBlockerLine,
  formatRoundCostValue,
  formatRoundPanelHeading,
  formatRoundResultLine,
  storyDetailMobileNavigation,
  type StoryRoundDto,
} from "../../console-ui/src/pages/detail/contracts.js";

/**
 * The mobile scenario is a layout fact the UI acceptance walkthrough judges on
 * a narrow viewport (design 08 section 6). CODE is fenced out of `*.test.ts`
 * for the scenarios SPECIFY froze, and SPECIFY downgraded this one to `ui`
 * because there is no CODE-layer boundary to assert. What CODE can fix down
 * here is the part that layout is built from: the single bottom entry labelled
 * `当前`, and the labels the narrow single column must show. The page renders
 * from exactly these, and the walkthrough checks the rendered order and that
 * the entry covers nothing.
 */
/**
 * The rendered page, read as its template AST and its stylesheet.
 *
 * The structural layer (design 08 section 6) reads role and text off ONE
 * accessibility node, so two things about the page are observable without a
 * browser: whether the failure message is the alert node's own text or is
 * buried in a child element, and whether the bottom navigation is actually
 * displayed at phone widths. Round 1 missed both, and both are properties of
 * this file, so the contract is checked where it lives.
 */
const PAGE = parse(
  readFileSync(fileURLToPath(new URL("../../console-ui/src/pages/detail/StoryDetailPage.vue", import.meta.url)), "utf8"),
).descriptor;

/** The slice of Vue's template AST this contract reads. */
interface AstNode {
  type: number;
  tag?: string;
  props?: Array<{ type: number; name?: string; value?: { content?: string } }>;
  children?: Array<AstNode | string>;
  content?: { content?: string };
}

const ELEMENT = 1;
const INTERPOLATION = 5;
const ATTRIBUTE = 6;

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    if (typeof child === "object") walk(child, visit);
  }
}

function allElements(): AstNode[] {
  const found: AstNode[] = [];
  walk(PAGE.template?.ast as AstNode, (node) => {
    if (node.type === ELEMENT) found.push(node);
  });
  return found;
}

function attribute(node: AstNode, name: string): string | null {
  for (const prop of node.props ?? []) {
    if (prop.type === ATTRIBUTE && prop.name === name) return prop.value?.content ?? "";
  }
  return null;
}

function interpolation(node: AstNode | string): string | null {
  return typeof node !== "string" && node.type === INTERPOLATION ? node.content?.content ?? null : null;
}

/** The body of the first rule whose selector contains `selector`, braces balanced. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

function displayOf(body: string): string | undefined {
  return /display\s*:\s*([^;]+)/.exec(body)?.[1]?.trim();
}

function currentRound(): StoryRoundDto {
  return {
    round: 3,
    trigger: "restart",
    triggerNote: null,
    phase: "CODE",
    startedAt: 1_700_000_000_000,
    endedAt: null,
    resultPending: false,
    acceptance: [
      { scenarioId: "S-R237511DT-02-gamma", text: "当前轮验收一", outcome: "passed" },
      { scenarioId: "S-R237511DT-02-delta", text: "当前轮验收二", outcome: "passed" },
      { scenarioId: "S-R237511DT-02-epsilon", text: "当前轮验收三", outcome: "failed" },
    ],
    costUsd: 1.24,
  };
}

describe("mobile layout contract", () => {
  it("@scenario S-R237511DT-02-mobile 手机底部只有一个回到当前轮的入口", () => {
    const navigation = storyDetailMobileNavigation();

    expect(navigation).toHaveLength(1);
    expect(navigation[0]?.label).toBe("当前");
    expect(navigation[0]?.current).toBe(true);
  });

  it("@scenario S-R237511DT-02-mobile 手机单列要看到的阶段、结果、卡点与费用标签都在冻结文案里", () => {
    const round = currentRound();

    expect(formatRoundPanelHeading(round.round, round.round)).toBe("当前轮阶段与结果");
    expect(formatRoundResultLine(round)).toBe("已取得的结果：2 项验收已通过");
    expect(formatRoundBlockerLine(round)).toBe("卡点：1 项验收未通过");
    expect(formatRoundCostValue(round, round.round)).toBe("$1.24（本任务当前轮）");
    expect(STORY_DETAIL_COPY.roundCostHeading).toBe("本轮费用");
    expect(STORY_DETAIL_COPY.historyHeading).toBe("历史轮次");
    expect(STORY_DETAIL_COPY.currentRunEntry).toBe("当前");
  });

  it("@scenario S-R237511DT-02-mobile 手机底部入口在窄视口真正显示，入口指向当前轮", () => {
    const styles = PAGE.styles.map((style) => style.content).join("\n");
    // Hidden on the desk (the shell owns desktop navigation), shown on the
    // phone. The base rule alone hid it at every width, which is why round 1
    // had no `当前` entry to see.
    expect(displayOf(ruleBody(styles, ".mobile-nav"))).toBe("none");
    const onPhone = displayOf(ruleBody(ruleBody(styles, "@media (max-width: 760px)"), ".mobile-nav"));
    expect(onPhone).toBeDefined();
    expect(onPhone).not.toBe("none");

    const nav = allElements().find((node) => (attribute(node, "class") ?? "").includes("mobile-nav"));
    expect(nav).toBeDefined();
    const links = (nav?.children ?? []).filter(
      (child): child is AstNode => typeof child === "object" && child.type === ELEMENT && child.tag === "a",
    );
    expect(links).toHaveLength(1);
    expect(interpolation((links[0]?.children ?? [])[0] ?? "")).toBe("entry.label");
  });

  it("@scenario S-R237511DT-02-error 读取失败提示是 alert 节点自身的内容", () => {
    const alerts = allElements().filter((node) => attribute(node, "role") === "alert");
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    // A message wrapped in a child element leaves the alert node with no text
    // of its own, so the accessibility tree never shows it on the alert.
    const nested = (alert.children ?? []).filter(
      (child): child is AstNode => typeof child === "object" && child.type === ELEMENT,
    );
    expect(nested).toHaveLength(0);
    expect((alert.children ?? []).map(interpolation)).toContain("STORY_DETAIL_COPY.failed");
  });
});
