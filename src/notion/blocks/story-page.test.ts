import { describe, expect, it } from "vitest";
import { planStoryPageUpdate, type StoryPageSnapshot } from "./story-page.js";

const snapshot: StoryPageSnapshot = {
  sections: {
    requirement: { anchorBlockId: "anchor-requirement" },
    specification: { anchorBlockId: "anchor-specification" },
    design: { anchorBlockId: "anchor-design", contentBlockId: "design-body", content: "old design" },
    verification: { anchorBlockId: "anchor-verification" },
    questions: { anchorBlockId: "anchor-questions" },
  },
  metadata: { blockId: "metadata-callout", content: "round 1" },
  specs: [
    { id: "S-1", seq: 1, status: "pending", text: "First behavior", blockId: "spec-block-1" },
  ],
  verificationRounds: [],
};

describe("planStoryPageUpdate", () => {
  it("updates a Spec in place so its block comment anchor survives", () => {
    const plan = planStoryPageUpdate(snapshot, {
      metadata: "round 2",
      design: "new design",
      specs: [
        { id: "S-1", seq: 1, status: "passed", text: "First behavior" },
        { id: "S-2", seq: 2, status: "pending", text: "Second behavior" },
      ],
      verificationRound: { round: 2, summary: "one of two passed" },
    });
    expect(plan).toContainEqual({
      type: "update_block",
      blockId: "spec-block-1",
      content: "S-1 [passed] First behavior",
    });
    expect(plan.some((operation) => operation.type === "archive_block" && operation.blockId === "spec-block-1")).toBe(false);
    expect(plan).toContainEqual(expect.objectContaining({ type: "insert_spec", specId: "S-2" }));
  });

  it("appends each verification round without rewriting an earlier toggle", () => {
    const roundTwo: StoryPageSnapshot = {
      ...snapshot,
      verificationRounds: [{ round: 1, toggleBlockId: "round-1", summary: "failed" }],
    };
    const plan = planStoryPageUpdate(roundTwo, {
      metadata: "round 2",
      design: "old design",
      specs: [{ id: "S-1", seq: 1, status: "passed", text: "First behavior" }],
      verificationRound: { round: 2, summary: "passed" },
    });
    expect(plan).toContainEqual(expect.objectContaining({
      type: "insert_verification_round",
      afterBlockId: "anchor-verification",
      round: 2,
    }));
    expect(plan.some((operation) => "blockId" in operation && operation.blockId === "round-1")).toBe(false);
  });

  it("archives only rounds beyond the latest eight", () => {
    const crowded: StoryPageSnapshot = {
      ...snapshot,
      verificationRounds: Array.from({ length: 8 }, (_, index) => ({
        round: index + 1,
        toggleBlockId: `round-${index + 1}`,
        summary: "done",
      })),
    };
    const plan = planStoryPageUpdate(crowded, {
      metadata: "round 9",
      design: "old design",
      specs: [{ id: "S-1", seq: 1, status: "passed", text: "First behavior" }],
      verificationRound: { round: 9, summary: "passed" },
    });
    expect(plan).toContainEqual({
      type: "archive_verification_rounds",
      rounds: [{ round: 1, toggleBlockId: "round-1" }],
    });
  });

  it("creates only missing section anchors and never replaces existing ones", () => {
    const missing: StoryPageSnapshot = {
      ...snapshot,
      sections: { requirement: snapshot.sections.requirement! },
    };
    const plan = planStoryPageUpdate(missing, {
      metadata: "round 1",
      design: "design",
      specs: [],
    });
    const created = plan.filter((operation) => operation.type === "create_section").map((operation) => operation.section);
    expect(created).toEqual(["specification", "design", "verification", "questions"]);
    expect(created).not.toContain("requirement");
  });
});
