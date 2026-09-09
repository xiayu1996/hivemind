// @scenario S-M2-01-artifact
// @scenario S-M2-01-language
// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external decomposition contract.
import { describe, expect, it } from "vitest";
import {
  evaluateDecomposition,
  inspectBusinessLanguage,
  type DecompositionCandidate,
  type RejectedDecomposition,
} from "./decompose.js";

const checkoutEpic: DecompositionCandidate = {
  epicId: "E-CHECKOUT",
  businessGoal: "Customers can complete a purchase with a promotion and receive a receipt.",
  stories: [
    {
      id: "S-CHECKOUT-01",
      title: "Customers can apply an eligible promotion",
      requirement: "Customers see the adjusted purchase total when they apply an eligible promotion.",
      userEntryPoint: "the S-CHECKOUT-01 view a person opens",
      verificationPath: "open the S-CHECKOUT-01 view and check the outcome",
      scenarios: [{ id: "S-CHECKOUT-01-promotion", given: "A customer has an eligible promotion", when: "They apply it to a purchase", then: "They see the adjusted total" }],
      dependsOn: [],
      predictedFootprint: ["checkout/pricing"],
    },
    {
      id: "S-CHECKOUT-02",
      title: "Customers receive a purchase receipt",
      requirement: "Customers receive a receipt after a successful purchase.",
      userEntryPoint: "the S-CHECKOUT-02 view a person opens",
      verificationPath: "open the S-CHECKOUT-02 view and check the outcome",
      scenarios: [{ id: "S-CHECKOUT-02-receipt", given: "A customer completes a purchase", when: "The purchase succeeds", then: "They receive a receipt" }],
      dependsOn: ["S-CHECKOUT-01"],
      predictedFootprint: ["checkout/receipts"],
    },
  ],
};

const accountEpic: DecompositionCandidate = {
  epicId: "E-ACCOUNT",
  businessGoal: "Members can control who sees their profile.",
  stories: [{
    id: "S-ACCOUNT-01",
    title: "Members can choose profile visibility",
    requirement: "Members can choose whether their profile is visible to everyone or only approved contacts.",
    userEntryPoint: "the S-ACCOUNT-01 view a person opens",
    verificationPath: "open the S-ACCOUNT-01 view and check the outcome",
    scenarios: [{ id: "S-ACCOUNT-01-visibility", given: "A member has a profile", when: "They choose approved contacts", then: "Only approved contacts can view the profile" }],
    dependsOn: [],
    predictedFootprint: ["accounts/profile-visibility"],
  }],
};

const deliveryEpic: DecompositionCandidate = {
  epicId: "E-DELIVERY",
  businessGoal: "Customers can follow the progress of a delivery.",
  stories: [{
    id: "S-DELIVERY-01",
    title: "Customers see delivery progress",
    requirement: "Customers can see whether their delivery is being prepared, on its way, or complete.",
    userEntryPoint: "the S-DELIVERY-01 view a person opens",
    verificationPath: "open the S-DELIVERY-01 view and check the outcome",
    scenarios: [{ id: "S-DELIVERY-01-progress", given: "A customer has placed an order", when: "They view the delivery", then: "They see its current progress" }],
    dependsOn: [],
    predictedFootprint: ["delivery/progress"],
  }],
};

describe("evaluateDecomposition", () => {
  it("accepts three business Epic decompositions with stable story order and preserved planning data", () => {
    for (const candidate of [checkoutEpic, accountEpic, deliveryEpic]) {
      const result = evaluateDecomposition(candidate);
      expect(result).toMatchObject({ kind: "accepted", epicId: candidate.epicId });
      if (result.kind === "accepted") {
        expect(result.stories.map((story) => story.id)).toEqual(candidate.stories.map((story) => story.id));
        expect(result.stories[0]?.predictedFootprint).toEqual([...candidate.stories[0]!.predictedFootprint].toSorted());
      }
    }
  });

  it("rejects a dependency that is missing or appears after the Story that needs it", () => {
    const missing = structuredClone(checkoutEpic);
    missing.stories[1]!.dependsOn = ["S-CHECKOUT-99"];
    expect(evaluateDecomposition(missing)).toMatchObject({ kind: "rejected", reasons: [expect.stringContaining("unknown dependency")] });

    const outOfOrder = structuredClone(checkoutEpic);
    outOfOrder.stories = outOfOrder.stories.toReversed();
    expect(evaluateDecomposition(outOfOrder)).toMatchObject({ kind: "rejected", reasons: [expect.stringContaining("must appear before")] });
  });

  it("rejects a human-facing line containing implementation language and reports its location", () => {
    const result = inspectBusinessLanguage("then", "Update src/checkout/route.ts with a React component");
    expect(result).toEqual([{ field: "then", line: 1, reason: expect.stringContaining("implementation language") }]);
    const candidate = structuredClone(checkoutEpic);
    candidate.stories[0]!.requirement = "Run npm test after changing src/checkout/route.ts";
    expect(evaluateDecomposition(candidate)).toMatchObject({ kind: "rejected", reasons: [expect.stringContaining("requirement line 1")] });
  });

  it("asks one specific blocking question without accepting incomplete work", () => {
    const result = evaluateDecomposition({
      epicId: "E-DELIVERY",
      businessGoal: "Customers can follow the progress of a delivery.",
      stories: [],
      blockingQuestion: "Do customers need live delivery updates, or only updates when the delivery status changes?",
    });
    expect(result).toEqual({
      kind: "blocking_question",
      epicId: "E-DELIVERY",
      question: { question: "Do customers need live delivery updates, or only updates when the delivery status changes?", options: [] },
    });

    expect(evaluateDecomposition({
      ...checkoutEpic,
      blockingQuestion: "Which receipt delivery method do customers need?",
    })).toMatchObject({ kind: "rejected", reasons: ["blocking question cannot include partial Stories"] });
  });
});

describe("@scenario S-M2-01-language business words that only look technical", () => {
  it("accepts the vocabulary a real requirement uses", () => {
    for (const line of [
      "客户输入优惠码后立即看到折后价。",
      "The customer enters a promotion code and sees the discounted price.",
      "运营在后台为一批客户实现自助退款。",
      "The class of customers on the annual plan keeps its discount.",
    ]) {
      expect(inspectBusinessLanguage("requirement", line)).toEqual([]);
    }
  });

  it("still refuses the words that describe construction rather than outcome", () => {
    for (const line of [
      "新增 scheduler 模块并重构调度函数。",
      "Add a React component that calls the pricing API.",
      "Update src/orchestrator/scheduler.ts and its schema.",
      "改代码时顺手把数据库表也改了。",
    ]) {
      expect(inspectBusinessLanguage("requirement", line)).toHaveLength(1);
    }
  });
});

// @scenario S-M2-06-splitnotice
const slice = (number: string, entryPoint: string, footprint: string) => ({
  id: `S-M2-${number}`,
  title: `Customer outcome ${number}`,
  requirement: `Customers receive outcome ${number}.`,
  userEntryPoint: entryPoint,
  verificationPath: `open ${entryPoint} and check the outcome`,
  // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the decomposition contract.
  scenarios: [{
    id: `S-M2-${number}-ready`,
    given: "a customer needs service",
    when: "the plan is approved",
    then: "the customer receives the outcome",
  }],
  dependsOn: [],
  predictedFootprint: [footprint],
});

const candidate = (stories: ReturnType<typeof slice>[]) => ({
  epicId: "M2",
  businessGoal: "Customers receive an ordered service plan.",
  stories,
});

describe("vertical slices", () => {
  it("accepts slices that each land somewhere else a person can look", () => {
    const result = evaluateDecomposition(candidate([
      slice("01", "the service plan page", "plan"),
      slice("02", "the monthly service report", "reporting"),
    ]));
    expect(result.kind).toBe("accepted");
  });

  it("refuses two Stories that show their outcome in the same place", () => {
    // Six cards for one page is what the 2026-09-05 Epic did, and none of them
    // could be verified or delivered on its own.
    const result = evaluateDecomposition(candidate([
      slice("01", "the service plan page", "plan"),
      slice("02", "the service plan page", "reporting"),
    ]));
    expect(result.kind).toBe("rejected");
    expect((result as RejectedDecomposition).reasons.join(" ")).toContain("cut into layers");
  });

  it("refuses an Epic cut by layer, where every Story claims the same footprint", () => {
    const result = evaluateDecomposition(candidate([
      slice("01", "the service plan page", "plan"),
      slice("02", "the monthly service report", "plan"),
    ]));
    expect((result as RejectedDecomposition).reasons.join(" ")).toContain("cut by layer");
  });

  it("refuses more Stories than the Epic is allowed to carry", () => {
    const stories = ["01", "02", "03", "04", "05"].map((number) =>
      slice(number, `the outcome ${number} page`, `area-${number}`));
    const result = evaluateDecomposition(candidate(stories), { maxStories: 4 });
    expect((result as RejectedDecomposition).reasons.join(" ")).toContain("more than the 4 allowed");
  });

  it("names the missing entry point and verification path rather than a shape error", () => {
    const broken = { ...slice("01", "", "plan"), verificationPath: "  " };
    const reasons = (evaluateDecomposition(candidate([broken])) as RejectedDecomposition).reasons.join(" ");
    expect(reasons).toContain("user-visible entry point");
    expect(reasons).toContain("without a sibling Story");
  });
});
