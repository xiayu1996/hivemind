import { describe, expect, it } from "vitest";
import {
  REQUIREMENT_SECTION_ORDER,
  planRequirementPageUpdate,
  type DesiredRequirementPage,
  type RequirementPageSnapshot,
} from "./requirement-page.js";

/** A page that already matches `desired()`, so a test shows only its own diff. */
function settledPage(overrides: Partial<Record<string, unknown>> = {}): RequirementPageSnapshot {
  const sections = {
    metadata: { anchorBlockId: "anchor-metadata", blocks: [{ id: "m", content: "状态: 澄清中 · 澄清轮次: 1" }] },
    original: { anchorBlockId: "anchor-original", blocks: [{ id: "o", content: "我想随时知道现在在做什么。" }] },
    clarify: { anchorBlockId: "anchor-clarify", blocks: [{ id: "c", content: "第 1 轮 问: 谁会用它？" }] },
    prd: { anchorBlockId: "anchor-prd", blocks: [{ id: "p", content: "业务目标: 值班的人随时看到进度" }] },
    acceptance: { anchorBlockId: "anchor-acceptance", blocks: [] },
    questions: { anchorBlockId: "anchor-questions", blocks: [] },
  };
  return { sections: { ...sections, ...overrides } } as RequirementPageSnapshot;
}

function desired(overrides: Partial<DesiredRequirementPage> = {}): DesiredRequirementPage {
  return {
    metadata: "状态: 澄清中 · 澄清轮次: 1",
    original: "我想随时知道现在在做什么。",
    clarify: ["第 1 轮 问: 谁会用它？"],
    prd: ["业务目标: 值班的人随时看到进度"],
    prdFrozen: false,
    acceptance: [],
    ...overrides,
  };
}

describe("planRequirementPageUpdate", () => {
  it("creates every owned section on a page that has none", () => {
    const operations = planRequirementPageUpdate({ sections: {} }, desired());
    expect(operations.filter((operation) => operation.type === "create_section").map((operation) =>
      operation.type === "create_section" ? operation.section : "")).toEqual([...REQUIREMENT_SECTION_ORDER]);
  });

  it("updates the metadata callout in place instead of stacking copies", () => {
    const snapshot = settledPage({
      metadata: { anchorBlockId: "anchor-metadata", blocks: [{ id: "callout", content: "状态: 待澄清" }] },
    });
    expect(planRequirementPageUpdate(snapshot, desired())).toContainEqual({
      type: "update_block",
      blockId: "callout",
      content: "状态: 澄清中 · 澄清轮次: 1",
    });
  });

  it("leaves the person's own words alone once they have written them", () => {
    const snapshot = settledPage({
      original: { anchorBlockId: "anchor-original", blocks: [{ id: "own", content: "我自己写的需求" }] },
    });
    const operations = planRequirementPageUpdate(snapshot, desired());
    expect(operations.some((operation) =>
      operation.type === "update_block" && operation.blockId === "own")).toBe(false);
    expect(operations.some((operation) => operation.type === "insert" && operation.section === "original")).toBe(false);
  });

  it("only ever adds to the clarification log", () => {
    const snapshot = settledPage({
      clarify: { anchorBlockId: "anchor-clarify", blocks: [{ id: "r1", content: "第 1 轮 问: 谁会用它？" }] },
    });
    const operations = planRequirementPageUpdate(snapshot, desired({
      clarify: ["第 1 轮 问: 谁会用它？", "第 1 轮 答: 值班的人"],
    }));
    expect(operations).toEqual([{
      type: "insert",
      section: "clarify",
      afterBlockId: "r1",
      content: "第 1 轮 答: 值班的人",
      block: "paragraph",
    }]);
  });

  it("replaces a draft PRD wholesale but never touches a confirmed one", () => {
    const snapshot = settledPage({
      prd: { anchorBlockId: "anchor-prd", blocks: [{ id: "old", content: "业务目标: 旧版本" }] },
    });
    const rewrite = planRequirementPageUpdate(snapshot, desired());
    expect(rewrite).toContainEqual({ type: "archive_block", blockId: "old" });
    expect(rewrite).toContainEqual({
      type: "insert",
      section: "prd",
      afterBlockId: "anchor-prd",
      content: "业务目标: 值班的人随时看到进度",
      block: "paragraph",
    });

    expect(planRequirementPageUpdate(snapshot, desired({ prdFrozen: true }))).toEqual([]);
  });

  it("adds checklist items as boxes and never rewrites a box a person may have ticked", () => {
    const snapshot = settledPage({
      acceptance: { anchorBlockId: "anchor-acceptance", blocks: [{ id: "a1", content: "场景一" }] },
    });
    const operations = planRequirementPageUpdate(snapshot, desired({
      acceptance: ["场景一", "场景二"],
    }));
    expect(operations).toEqual([{
      type: "insert",
      section: "acceptance",
      afterBlockId: "a1",
      content: "场景二",
      block: "to_do",
    }]);
  });

  it("shows the wait for a person as one paragraph and clears it once they answered", () => {
    expect(planRequirementPageUpdate(settledPage(), desired({ questions: "系统已停下等你回答：还差谁会用它" }))).toEqual([{
      type: "insert",
      section: "questions",
      afterBlockId: "anchor-questions",
      content: "系统已停下等你回答：还差谁会用它",
      block: "paragraph",
    }]);
    const waiting = settledPage({
      questions: { anchorBlockId: "anchor-questions", blocks: [{ id: "q", content: "系统已停下等你回答：还差谁会用它" }] },
    });
    expect(planRequirementPageUpdate(waiting, desired({ questions: "系统已停下等你回答：预算用完" }))).toEqual([
      { type: "update_block", blockId: "q", content: "系统已停下等你回答：预算用完" },
    ]);
    expect(planRequirementPageUpdate(waiting, desired())).toEqual([{ type: "archive_block", blockId: "q" }]);
  });

  it("settles: a page already matching the record needs no edits", () => {
    expect(planRequirementPageUpdate(settledPage(), desired())).toEqual([]);
  });
});
