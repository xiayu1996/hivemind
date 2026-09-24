/* oxlint-disable unicorn/no-thenable -- contract fixtures use the contract's given/when/then vocabulary; every value is a string, never a function. */
import { describe, expect, it } from "vitest";
import { contractScenarios, contractSchema } from "./contract.ts";
import { checkVerdict, verdictSchema, type Evidence, type EvidenceMatcher } from "./verdict.ts";

const scenarios = contractScenarios(
  contractSchema.parse({
    items: [
      {
        id: "A1",
        title: "查看待办",
        surface: "web",
        scenarios: [
          { id: "A1.1", title: "列表", given: "已有两条待办", when: "打开待办页", then: "两条待办都出现在列表里", page: "/todos", visible: [{ text: "买牛奶" }] },
          { id: "A1.2", title: "空态", given: "没有待办", when: "打开待办页", then: "显示暂无待办", page: "/todos", visible: [{ text: "暂无待办" }] },
        ],
      },
    ],
  }),
);

const matcher: EvidenceMatcher = {
  matchSnapshot: (text, scenario) => {
    const missing = scenario.visible.filter((entry) => entry.text !== undefined && !text.includes(entry.text)).map((entry) => entry.text ?? "");
    return { ok: missing.length === 0, missing };
  },
  matchOutput: () => ({ ok: false, missing: ["unused"] }),
};

const evidence = new Map<string, Evidence>([
  ["S1", { id: "S1", kind: "snapshot", path: "/todos", text: '- listitem: "买牛奶"' }],
  ["S2", { id: "S2", kind: "snapshot", path: "/other", text: '- listitem: "买牛奶"' }],
  ["S3", { id: "S3", kind: "snapshot", path: "/todos?x=1", text: "- paragraph: 暂无待办" }],
]);

function verdict(entries: unknown[]) {
  return verdictSchema.parse({ scenarios: entries });
}

describe("evaluator verdict", () => {
  it("accepts passes backed by a snapshot of the declared page", () => {
    const result = checkVerdict(
      verdict([
        { id: "A1.1", outcome: "passed", reason: "看到了", evidence: ["S1"] },
        { id: "A1.2", outcome: "passed", reason: "看到了", evidence: ["S3"] },
      ]),
      scenarios,
      evidence,
      matcher,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verdict.passed.map((entry) => entry.id)).toEqual(["A1.1", "A1.2"]);
  });

  it("refuses a pass without evidence, with unknown evidence, or on another page", () => {
    const result = checkVerdict(
      verdict([
        { id: "A1.1", outcome: "passed", reason: "r", evidence: ["S2"] },
        { id: "A1.2", outcome: "passed", reason: "r", evidence: [] },
      ]),
      scenarios,
      evidence,
      matcher,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.findings[0]).toContain("taken on /other");
      expect(result.findings[1]).toContain("without evidence");
    }
    const ghost = checkVerdict(verdict([{ id: "A1.1", outcome: "passed", reason: "r", evidence: ["S9"] }, { id: "A1.2", outcome: "inconclusive", reason: "r" }]), scenarios, evidence, matcher);
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.findings[0]).toContain("never captured: S9");
  });

  it("refuses a failure that does not quote the contract", () => {
    const result = checkVerdict(
      verdict([
        { id: "A1.1", outcome: "failed", reason: "间距太挤", cites: "按钮间距应为 8px" },
        { id: "A1.2", outcome: "failed", reason: "没有空态", cites: "显示暂无待办" },
      ]),
      scenarios,
      evidence,
      matcher,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toContain("A1.1");
    }
  });

  it("requires exactly the scenarios asked for", () => {
    const result = checkVerdict(verdict([{ id: "A9.1", outcome: "inconclusive", reason: "r" }]), scenarios, evidence, matcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.findings.some((finding) => finding.includes("A9.1"))).toBe(true);
      expect(result.findings.some((finding) => finding.includes("A1.1 has no outcome"))).toBe(true);
    }
  });
});
