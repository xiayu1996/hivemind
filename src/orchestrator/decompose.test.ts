// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external decomposition contract.
import { describe, expect, it } from "vitest";
import {
  evaluateDecomposition,
  inspectBusinessLanguage,
  type DecompositionCandidate,
} from "./decompose.js";

const checkoutEpic: DecompositionCandidate = {
  epicId: "E-CHECKOUT",
  businessGoal: "Customers can complete a purchase with a promotion and receive a receipt.",
  stories: [
    {
      id: "S-CHECKOUT-01",
      title: "Customers can apply an eligible promotion",
      requirement: "Customers see the adjusted purchase total when they apply an eligible promotion.",
      scenarios: [{ id: "S-CHECKOUT-01-promotion", given: "A customer has an eligible promotion", when: "They apply it to a purchase", then: "They see the adjusted total" }],
      dependsOn: [],
      predictedFootprint: ["checkout/pricing"],
    },
    {
      id: "S-CHECKOUT-02",
      title: "Customers receive a purchase receipt",
      requirement: "Customers receive a receipt after a successful purchase.",
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
      question: "Do customers need live delivery updates, or only updates when the delivery status changes?",
    });

    expect(evaluateDecomposition({
      ...checkoutEpic,
      blockingQuestion: "Which receipt delivery method do customers need?",
    })).toMatchObject({ kind: "rejected", reasons: ["blocking question cannot include partial Stories"] });
  });
});
