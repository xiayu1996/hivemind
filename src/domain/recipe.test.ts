import { describe, expect, it } from "vitest";
import { checkRecipe, chooseRecipe, nextStepIndex, recipeSchema } from "./recipe.ts";

const recipe = recipeSchema.parse({
  name: "greenfield",
  description: "d",
  steps: [
    { id: "define", kind: "author", prompt: "define", writes: ["PRODUCT.md", "acceptance.yaml"], approval: "always", gate: "product" },
    { id: "prototype", kind: "author", prompt: "prototype", writes: ["prototype/index.html"], when: "has_web_surface", approval: "always", gate: "product" },
    { id: "architect", kind: "author", prompt: "architect", writes: ["ARCHITECTURE.md", "project.yaml", "plan.yaml"], approval: "on_change", gate: "architecture", research: true },
    { id: "build", kind: "build" },
    { id: "review", kind: "review", prompt: "review", approval: "always", gate: "milestone" },
  ],
});

describe("recipe", () => {
  it("accepts a recipe whose build step has everything it reads", () => {
    expect(checkRecipe(recipe)).toEqual([]);
  });

  it("refuses a build step before its inputs are written", () => {
    const broken = recipeSchema.parse({
      name: "broken",
      description: "d",
      steps: [{ id: "build", kind: "build" }, { id: "review", kind: "review" }],
    });
    const findings = checkRecipe(broken);
    expect(findings.filter((finding) => finding.includes("needs")).length).toBe(3);
  });

  it("needs a gate for every step a person approves", () => {
    const broken = recipeSchema.parse({ ...recipe, steps: recipe.steps.map((step) => (step.id === "review" ? { ...step, gate: undefined } : step)) });
    expect(checkRecipe(broken)).toEqual(["recipe greenfield: step review asks for approval but names no gate"]);
  });

  it("insists on exactly one build and a final review", () => {
    const broken = recipeSchema.parse({
      name: "broken",
      description: "d",
      steps: [{ id: "define", kind: "author", prompt: "p", writes: ["acceptance.yaml", "plan.yaml", "project.yaml"] }],
    });
    const findings = checkRecipe(broken);
    expect(findings.some((finding) => finding.includes("exactly one build"))).toBe(true);
    expect(findings.some((finding) => finding.includes("last step must be a review"))).toBe(true);
  });

  it("skips steps whose condition does not hold", () => {
    expect(nextStepIndex(recipe, 1, { hasWebSurface: false, hasArchitecture: false })).toBe(2);
    expect(nextStepIndex(recipe, 1, { hasWebSurface: true, hasArchitecture: false })).toBe(1);
    expect(nextStepIndex(recipe, 5, { hasWebSurface: true, hasArchitecture: false })).toBeNull();
  });

  it("chooses deterministically", () => {
    expect(chooseRecipe("small-change", ["greenfield", "feature", "small-change"], "feature")).toBe("small-change");
    expect(chooseRecipe(null, ["greenfield", "feature"], "greenfield")).toBe("greenfield");
    expect(chooseRecipe("unknown", ["greenfield", "feature"], "feature")).toBe("feature");
  });
});
