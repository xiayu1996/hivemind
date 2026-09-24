/* oxlint-disable unicorn/no-thenable -- contract fixtures use the contract's given/when/then vocabulary; every value is a string, never a function. */
import { describe, expect, it } from "vitest";
import { checkContract, contractScenarios, contractSchema, hasWebSurface } from "./contract.ts";

const base = {
  items: [
    {
      id: "A1",
      title: "查看待办",
      surface: "web",
      scenarios: [
        {
          id: "A1.1",
          title: "列表显示已有待办",
          given: "已有两条待办",
          when: "打开待办页",
          then: "两条待办都出现在列表里",
          page: "/todos",
          visible: [{ role: "heading", text: "待办" }, { text: "买牛奶" }],
          seed: "two-todos",
        },
      ],
    },
  ],
};

describe("acceptance contract", () => {
  it("accepts a well-formed contract and defaults mutates to false", () => {
    const contract = contractSchema.parse(base);
    expect(checkContract(contract)).toEqual([]);
    expect(contract.items[0]?.scenarios[0]?.mutates).toBe(false);
    expect(hasWebSurface(contract)).toBe(true);
  });

  it("requires a page on web scenarios and a command on cli scenarios", () => {
    const contract = contractSchema.parse({
      items: [
        { id: "A1", title: "t", surface: "web", scenarios: [{ id: "A1.1", title: "t", given: "g", when: "w", then: "t", visible: [{ text: "x" }] }] },
        { id: "A2", title: "t", surface: "cli", scenarios: [{ id: "A2.1", title: "t", given: "g", when: "w", then: "t", visible: [{ text: "x" }] }] },
      ],
    });
    const findings = checkContract(contract);
    expect(findings.some((finding) => finding.includes("A1.1") && finding.includes("page"))).toBe(true);
    expect(findings.some((finding) => finding.includes("A2.1") && finding.includes("command"))).toBe(true);
  });

  it("rejects a scenario whose id does not start with its item id", () => {
    const contract = contractSchema.parse({
      items: [{ ...base.items[0], scenarios: [{ ...base.items[0]!.scenarios[0], id: "A2.1" }] }],
    });
    expect(checkContract(contract)[0]).toContain('must start with "A1."');
  });

  it("asks a screen that changes something for a same-page reopen witness", () => {
    const changing = { ...base.items[0]!.scenarios[0], id: "A1.2", mutates: true };
    const contract = contractSchema.parse({ items: [{ ...base.items[0], scenarios: [base.items[0]!.scenarios[0], changing] }] });
    expect(checkContract(contract)[0]).toContain("reopens /todos");

    const witnessed = contractSchema.parse({
      items: [{ ...base.items[0], scenarios: [base.items[0]!.scenarios[0], { ...changing, persistedBy: "A1.1" }] }],
    });
    expect(checkContract(witnessed)).toEqual([]);

    const otherPage = contractSchema.parse({
      items: [
        {
          ...base.items[0],
          scenarios: [{ ...base.items[0]!.scenarios[0], page: "/elsewhere" }, { ...changing, persistedBy: "A1.1" }],
        },
      ],
    });
    expect(checkContract(otherPage)[0]).toContain("must reopen the same page");
  });

  it("rejects a visible expectation that names nothing", () => {
    const result = contractSchema.safeParse({
      items: [{ ...base.items[0], scenarios: [{ ...base.items[0]!.scenarios[0], visible: [{}] }] }],
    });
    expect(result.success).toBe(false);
  });

  it("flattens scenarios with their item surface, optionally for chosen items", () => {
    const contract = contractSchema.parse(base);
    expect(contractScenarios(contract).map((scenario) => [scenario.id, scenario.itemId, scenario.surface])).toEqual([["A1.1", "A1", "web"]]);
    expect(contractScenarios(contract, ["A9"])).toEqual([]);
  });
});
