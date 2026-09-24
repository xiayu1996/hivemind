/* oxlint-disable unicorn/no-thenable -- contract fixtures use the contract's given/when/then vocabulary; every value is a string, never a function. */
import { describe, expect, it } from "vitest";
import { contractSchema } from "./contract.ts";
import { checkPlan, findDependencyCycle, pickNext, planSchema, type ItemStatus } from "./plan.ts";

const contract = contractSchema.parse({
  items: ["A1", "A2"].map((id) => ({
    id,
    title: id,
    surface: "cli",
    scenarios: [{ id: `${id}.1`, title: "t", given: "g", when: "w", then: "t", command: "run", visible: [{ text: "ok" }] }],
  })),
});

const plan = planSchema.parse({
  items: [
    { id: "foundation", kind: "enabling", title: "地基", goal: "checks run" },
    { id: "list", kind: "feature", title: "列表", goal: "list", covers: ["A1"], dependsOn: ["foundation"] },
    { id: "edit", kind: "feature", title: "编辑", goal: "edit", covers: ["A2"], dependsOn: ["list"] },
  ],
});

describe("plan", () => {
  it("accepts a plan covering every acceptance item exactly once", () => {
    expect(checkPlan(plan, contract)).toEqual([]);
  });

  it("names uncovered and doubly covered acceptance items", () => {
    const gaps = planSchema.parse({ items: [{ id: "a", kind: "feature", title: "a", goal: "a", covers: ["A1"] }, { id: "b", kind: "feature", title: "b", goal: "b", covers: ["A1"] }] });
    const findings = checkPlan(gaps, contract);
    expect(findings.some((finding) => finding.includes("A2") && finding.includes("no plan item"))).toBe(true);
    expect(findings.some((finding) => finding.includes("A1") && finding.includes("exactly one"))).toBe(true);
  });

  it("finds dependency cycles and unknown dependencies", () => {
    const cyclic = planSchema.parse({
      items: [
        { id: "a", kind: "feature", title: "a", goal: "a", covers: ["A1"], dependsOn: ["b"] },
        { id: "b", kind: "feature", title: "b", goal: "b", covers: ["A2"], dependsOn: ["a", "ghost"] },
      ],
    });
    expect(findDependencyCycle(cyclic.items)).toEqual(["a", "b", "a"]);
    const findings = checkPlan(cyclic, contract);
    expect(findings.some((finding) => finding.includes("ghost"))).toBe(true);
    expect(findings.some((finding) => finding.includes("cycle"))).toBe(true);
  });

  it("picks the first ready pending item in plan order", () => {
    const statuses = new Map<string, ItemStatus>();
    expect(pickNext(plan, statuses)).toMatchObject({ kind: "item", item: { id: "foundation" } });
    statuses.set("foundation", "passed");
    expect(pickNext(plan, statuses)).toMatchObject({ kind: "item", item: { id: "list" } });
    statuses.set("list", "passed");
    statuses.set("edit", "passed");
    expect(pickNext(plan, statuses)).toEqual({ kind: "done" });
  });

  it("reports blocked when nothing pending can start", () => {
    const statuses = new Map<string, ItemStatus>([["foundation", "blocked"]]);
    expect(pickNext(plan, statuses)).toEqual({ kind: "blocked", waitingOn: ["foundation", "list", "edit"] });
  });
});
