import { describe, expect, it } from "vitest";
import { planStoryPageUpdate, type DesiredStoryPage, type StoryPageSnapshot } from "./story-page.js";
import { specLine, type DesiredRound } from "./story-render.js";

const specOne = { id: "S-EPIC1-01-a", seq: 1, status: "pending", title: "保存规则并回显" };

const round = (number: number, verdict = "accepted"): DesiredRound => ({
  round: number,
  at: 1_757_923_680_000,
  verdict,
  passed: 1,
  total: 1,
  rows: [{ scenario: "场景 1 · 保存规则并回显", test: "通过", screen: "—", note: "" }],
});

const snapshot: StoryPageSnapshot = {
  sections: {
    requirement: { anchorBlockId: "anchor-requirement", title: "需求描述" },
    specification: { anchorBlockId: "anchor-specification", title: "验收场景" },
    design: { anchorBlockId: "anchor-design", title: "设计摘要", contentBlockId: "design-body", content: "旧的设计" },
    verification: { anchorBlockId: "anchor-verification", title: "验证记录" },
    questions: { anchorBlockId: "anchor-questions", title: "需要你处理" },
    technical: { anchorBlockId: "anchor-technical", title: "技术细节" },
  },
  metadata: { blockId: "metadata-callout", content: "回复本页评论" },
  specs: [{ id: specOne.id, seq: 1, line: specLine(specOne), blockId: "spec-block-1" }],
  verificationRounds: [],
};

const desired = (overrides: Partial<DesiredStoryPage> = {}): DesiredStoryPage => ({
  design: "旧的设计",
  specs: [specOne],
  ...overrides,
});

describe("planStoryPageUpdate", () => {
  it("updates a Spec in place so its block comment anchor survives", () => {
    const passed = { ...specOne, status: "passed" };
    const second = { id: "S-EPIC1-01-b", seq: 2, status: "pending", title: "删除规则后列表不再显示" };
    const plan = planStoryPageUpdate(snapshot, desired({
      specs: [passed, second],
      verificationRound: round(2, "rejected"),
    }));
    expect(plan).toContainEqual({ type: "update_block", blockId: "spec-block-1", content: specLine(passed) });
    expect(plan.some((operation) => operation.type === "archive_block" && operation.blockId === "spec-block-1")).toBe(false);
    expect(plan).toContainEqual(expect.objectContaining({ type: "insert_spec", specId: second.id }));
  });

  it("appends each verification round without rewriting an earlier toggle", () => {
    const roundTwo: StoryPageSnapshot = {
      ...snapshot,
      verificationRounds: [{ round: 1, toggleBlockId: "round-1", summary: "第 1 轮 · 09-15 17:28 · 0/1 通过 ❌" }],
    };
    const plan = planStoryPageUpdate(roundTwo, desired({ verificationRound: round(2) }));
    expect(plan).toContainEqual(expect.objectContaining({
      type: "insert_verification_round",
      afterBlockId: "anchor-verification",
      round: expect.objectContaining({ round: 2 }),
    }));
    expect(plan.some((operation) => "blockId" in operation && operation.blockId === "round-1")).toBe(false);
  });

  it("archives only rounds beyond the latest eight", () => {
    const crowded: StoryPageSnapshot = {
      ...snapshot,
      verificationRounds: Array.from({ length: 8 }, (_, index) => ({
        round: index + 1,
        toggleBlockId: `round-${index + 1}`,
        summary: "第 N 轮",
      })),
    };
    const plan = planStoryPageUpdate(crowded, desired({ verificationRound: round(9) }));
    expect(plan).toContainEqual({
      type: "archive_verification_rounds",
      rounds: [{ round: 1, toggleBlockId: "round-1" }],
    });
  });

  it("creates only missing section anchors and never replaces existing ones", () => {
    const missing: StoryPageSnapshot = {
      ...snapshot,
      sections: { requirement: snapshot.sections.requirement! },
      specs: [],
    };
    const plan = planStoryPageUpdate(missing, desired({ specs: [] }));
    const created = plan.filter((operation) => operation.type === "create_section").map((operation) => operation.section);
    expect(created).toEqual(["specification", "design", "verification", "questions", "technical"]);
    expect(created).not.toContain("requirement");
  });

  it("renames a heading an older page wrote without replacing its block", () => {
    const old: StoryPageSnapshot = {
      ...snapshot,
      sections: { ...snapshot.sections, specification: { anchorBlockId: "anchor-specification", title: "需求规格" } },
    };
    const plan = planStoryPageUpdate(old, desired());
    expect(plan).toContainEqual({ type: "rename_section", section: "specification", blockId: "anchor-specification" });
    expect(plan.some((operation) => operation.type === "create_section" && operation.section === "specification")).toBe(false);
  });

  it("keeps the callout block and says nothing is waiting, rather than losing its place at the top", () => {
    const plan = planStoryPageUpdate(snapshot, desired());
    expect(plan).toContainEqual({
      type: "update_block",
      blockId: "metadata-callout",
      content: "现在没有等你处理的事。",
    });
    expect(plan.some((operation) => operation.type === "archive_block")).toBe(false);
  });

  it("creates metadata when the page template does not contain a callout", () => {
    const withoutMetadata: StoryPageSnapshot = {
      sections: snapshot.sections,
      specs: snapshot.specs,
      verificationRounds: snapshot.verificationRounds,
    };
    const plan = planStoryPageUpdate(withoutMetadata, desired({ metadata: "回复本页评论" }));
    expect(plan).toContainEqual({ type: "insert_metadata", content: "回复本页评论" });
  });
});
