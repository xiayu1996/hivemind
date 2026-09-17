// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external PRD contract.
import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_SECTION_ORDER,
  planRequirementPageUpdate,
  prdFrozenLine,
  prdLines,
  type DesiredPrd,
  type DesiredRequirementPage,
  type RequirementPageSnapshot,
} from "./requirement-page.js";

const PRD: DesiredPrd = {
  goal: "值班的人随时看到进度",
  nonGoals: ["不做权限管理"],
  scenarios: [{ id: "s01", given: "值班的人打开首屏", when: "刷新页面", then: "看到全部在等人的卡片" }],
  openQuestions: [],
  frozen: false,
};

const ROUND = {
  round: 1,
  line: "第 1 轮 · 1 题 · 已回答",
  items: [{ question: "谁会用它？", options: ["A. 值班的人"], answer: "A", reading: "A（选了 A：值班的人）" }],
};

/** A page that already matches `desired()`, so a test shows only its own diff. */
function settledPage(overrides: Partial<RequirementPageSnapshot> = {}): RequirementPageSnapshot {
  return {
    preface: [{ id: "own", content: "我想随时知道现在在做什么。" }],
    callout: { id: "callout", content: "现在没有等你处理的事。" },
    sections: {
      clarify: { anchorBlockId: "anchor-clarify", title: "澄清记录", blocks: [{ id: "r1", content: ROUND.line }] },
      prd: {
        anchorBlockId: "anchor-prd",
        title: "PRD",
        blocks: prdLines(PRD).map((content, index) => ({ id: `p${index}`, content })),
      },
      delivery: {
        anchorBlockId: "anchor-delivery",
        title: "交付结果",
        blocks: [{ id: "d", content: "场景由承接它们的 Epic 逐批验收。" }],
      },
    },
    retired: [],
    ...overrides,
  };
}

function desired(overrides: Partial<DesiredRequirementPage> = {}): DesiredRequirementPage {
  return {
    callout: "现在没有等你处理的事。",
    original: "我想随时知道现在在做什么。",
    clarify: [ROUND],
    prd: PRD,
    delivery: "场景由承接它们的 Epic 逐批验收。",
    ...overrides,
  };
}

describe("planRequirementPageUpdate", () => {
  it("settles: a page already matching the record needs no edits", () => {
    expect(planRequirementPageUpdate(settledPage(), desired())).toEqual([]);
  });

  it("creates every owned section on a page that has none", () => {
    const bare: RequirementPageSnapshot = { preface: [], sections: {}, retired: [] };
    const operations = planRequirementPageUpdate(bare, desired());
    expect(operations.filter((operation) => operation.type === "create_section").map((operation) =>
      operation.type === "create_section" ? operation.section : "")).toEqual([...REQUIREMENT_SECTION_ORDER]);
    // A card that arrived as a title alone gets the request written into its
    // own preface, above everything.
    expect(operations).toContainEqual({ type: "insert_preface", content: "我想随时知道现在在做什么。" });
  });

  it("leaves the person's own words alone once they have written them", () => {
    const operations = planRequirementPageUpdate(settledPage(), desired());
    expect(operations.some((operation) => operation.type === "insert_preface")).toBe(false);
    expect(operations.some((operation) =>
      operation.type === "update_block" && operation.blockId === "own")).toBe(false);
  });

  it("writes what a person has to do into the callout, in place", () => {
    const operations = planRequirementPageUpdate(settledPage(), desired({ callout: "回复本页最新一条评论。" }));
    expect(operations).toEqual([{ type: "update_block", blockId: "callout", content: "回复本页最新一条评论。" }]);
  });

  it("takes away a heading this page no longer has", () => {
    const operations = planRequirementPageUpdate(settledPage({ retired: ["old-heading", "old-body"] }), desired());
    expect(operations).toEqual([
      { type: "archive_block", blockId: "old-heading" },
      { type: "archive_block", blockId: "old-body" },
    ]);
  });

  it("renames a heading an older page wrote without replacing its block", () => {
    const page = settledPage();
    const operations = planRequirementPageUpdate({
      ...page,
      sections: { ...page.sections, delivery: { ...page.sections.delivery!, title: "场景化验收清单" } },
    }, desired());
    expect(operations).toEqual([{ type: "rename_section", section: "delivery", blockId: "anchor-delivery" }]);
  });

  it("adds a clarification round and rewrites only the one that was answered", () => {
    const waiting = { ...ROUND, line: "第 1 轮 · 1 题 · 等你回答" };
    const page = settledPage();
    const answered = planRequirementPageUpdate({
      ...page,
      sections: {
        ...page.sections,
        clarify: { anchorBlockId: "anchor-clarify", title: "澄清记录", blocks: [{ id: "r1", content: waiting.line }] },
      },
    }, desired());
    expect(answered).toEqual([{ type: "update_round", blockId: "r1", round: 1 }]);

    const second = { round: 2, line: "第 2 轮 · 2 题 · 等你回答", items: [] };
    expect(planRequirementPageUpdate(page, desired({ clarify: [ROUND, second] })))
      .toEqual([{ type: "insert_round", afterBlockId: "r1", round: 2 }]);
  });

  it("replaces a draft PRD wholesale but never touches a confirmed one", () => {
    const page = settledPage();
    const changed = planRequirementPageUpdate(page, desired({ prd: { ...PRD, goal: "新的目标" } }));
    expect(changed.filter((operation) => operation.type === "archive_block")).toHaveLength(prdLines(PRD).length);
    expect(changed).toContainEqual({ type: "insert_prd", afterBlockId: "anchor-prd" });

    // Confirmation only adds the banner: the words are the ones a person
    // approved, so they are not rewritten to make room for a line.
    expect(planRequirementPageUpdate(page, desired({ prd: { ...PRD, frozen: true } })))
      .toEqual([{ type: "insert_prd_banner", afterBlockId: "anchor-prd" }]);

    const frozen: RequirementPageSnapshot = {
      ...page,
      sections: {
        ...page.sections,
        prd: {
          anchorBlockId: "anchor-prd",
          title: "PRD",
          blocks: [{ id: "banner", content: prdFrozenLine() }, ...page.sections.prd!.blocks],
        },
      },
    };
    expect(planRequirementPageUpdate(frozen, desired({ prd: { ...PRD, goal: "谁也不许改", frozen: true } }))).toEqual([]);
  });

  it("keeps the delivery line to one block and rewrites it in place", () => {
    const operations = planRequirementPageUpdate(settledPage(), desired({ delivery: "已验收 1/2 个场景。" }));
    expect(operations).toEqual([{ type: "update_block", blockId: "d", content: "已验收 1/2 个场景。" }]);
  });
});
