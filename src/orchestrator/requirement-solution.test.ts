import { describe, expect, it } from "vitest";
import {
  approvalReasons,
  evaluateSolution,
  solutionNeedsApproval,
  type SolutionBody,
  type SolutionCandidate,
} from "./requirement-solution.js";

function solution(overrides: Partial<SolutionCandidate> = {}): SolutionCandidate {
  return {
    approach: {
      summary: "沿用仓库现有的服务端与检查方式，只在现有只读接口上补这条需求要的查询。",
      alternatives: [],
    },
    ...overrides,
  };
}

function accepted(candidate: SolutionCandidate): SolutionBody {
  const result = evaluateSolution(candidate);
  if (result.kind !== "accepted") throw new Error(`expected an accepted solution: ${result.reasons.join("; ")}`);
  return {
    approach: result.approach,
    stackChanges: result.stackChanges,
    openDecisions: result.openDecisions,
    qualityGates: result.qualityGates,
    interface: result.interface,
  };
}

describe("evaluateSolution", () => {
  it("takes a solution that keeps the stack and asks nothing", () => {
    expect(evaluateSolution(solution())).toMatchObject({
      kind: "accepted",
      stackChanges: [],
      openDecisions: [],
      interface: null,
    });
  });

  it("refuses a stack change with nothing to compare it against", () => {
    const result = evaluateSolution(solution({
      stackChanges: [{
        kind: "added",
        name: "vite",
        reason: "页面需要一个能出构建产物的工具。",
        impact: "package.json, CI build step",
      }],
      qualityGates: [{ name: "ui-build", command: ["npm", "run", "build:ui"], covers: "bundle compiles" }],
    }));

    expect(result).toMatchObject({ kind: "rejected" });
    expect(result.kind === "rejected" && result.reasons).toContain(
      "a solution that changes the stack must list the alternatives it turned down",
    );
  });

  it("refuses a stack change nothing checks: a new stack without a gate fails at a person", () => {
    const result = evaluateSolution(solution({
      approach: {
        summary: "引入一套构建工具来产出页面。",
        alternatives: [{ option: "手写静态文件", reason: "每加一页都要重复同样的模板。" }],
      },
      stackChanges: [{
        kind: "added",
        name: "vite",
        reason: "页面需要一个能出构建产物的工具。",
        impact: "package.json, CI build step",
      }],
    }));

    expect(result.kind === "rejected" && result.reasons).toContain(
      "a solution that changes the stack must say which check will hold the new stack",
    );
  });

  it("holds the words a person reads to their own language", () => {
    const result = evaluateSolution(solution({
      approach: { summary: "Reuse the existing Fastify server and add two routes.", alternatives: [] },
    }));

    expect(result.kind === "rejected" && result.reasons.join(" ")).toContain("not written in Chinese");
  });

  it("refuses an interface with no pages, because the pages are what the split is cut along", () => {
    const result = evaluateSolution(solution({ interface: { kind: "web", pages: [] } }));
    expect(result.kind === "rejected" && result.reasons).toContain("an interface must list the pages it is made of");
  });

  it("refuses a platform this installation cannot show works", () => {
    const result = evaluateSolution(solution({
      interface: { kind: "mobile", pages: [{ name: "任务列表", purpose: "让人一眼看到哪些任务在等自己" }] },
    }));

    expect(result.kind === "rejected" && result.reasons).toContain(
      "an interface on mobile must say how this installation proves its screens work",
    );
  });
});

describe("solutionNeedsApproval", () => {
  it("does not spend a person on a solution that decides nothing they would want to decide", () => {
    expect(solutionNeedsApproval(accepted(solution()))).toBe(false);
  });

  it("stops for a person on each of the three expensive kinds, and says which", () => {
    const withStack = accepted(solution({
      approach: {
        summary: "引入一套构建工具来产出页面。",
        alternatives: [{ option: "手写静态文件", reason: "每加一页都要重复同样的模板。" }],
      },
      stackChanges: [{ kind: "added", name: "vite", reason: "需要构建产物。", impact: "package.json" }],
      qualityGates: [{ name: "ui-build", command: ["npm", "run", "build:ui"], covers: "bundle compiles" }],
    }));
    const withQuestion = accepted(solution({
      openDecisions: [{ question: "手机优先还是电脑优先？", recommendation: "先做手机，电脑用同一套页面。" }],
    }));
    const withInterface = accepted(solution({
      interface: { kind: "web", pages: [{ name: "任务列表", purpose: "让人一眼看到哪些任务在等自己" }] },
    }));

    expect(solutionNeedsApproval(withStack)).toBe(true);
    expect(approvalReasons(withStack)).toEqual(["stack_changes"]);
    expect(solutionNeedsApproval(withQuestion)).toBe(true);
    expect(approvalReasons(withQuestion)).toEqual(["open_decisions"]);
    expect(solutionNeedsApproval(withInterface)).toBe(true);
    expect(approvalReasons(withInterface)).toEqual(["interface"]);
  });
});
