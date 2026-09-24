import { describe, expect, it } from "vitest";
import { evaluateClarification, evaluatePrd } from "./requirement-artifacts.js";

const REQUIREMENT_ID = "R-abc123def456";

function scenario(id: string) {
  return {
    id,
    given: "值班的人打开看板",
    when: "有需求正在等他回答问题",
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
    then: "他一眼看到在等谁、等什么",
  };
}

describe("evaluateClarification", () => {
  it("accepts a batch of business questions", () => {
    expect(evaluateClarification({ status: "ask", questions: ["谁会用这个看板？", "他多久看一次？"] }, 6))
      .toEqual({ kind: "ask", questions: [{ question: "谁会用这个看板？", options: [] }, { question: "他多久看一次？", options: [] }] });
  });

  it("bounces a question that asks the person to make an implementation decision", () => {
    const result = evaluateClarification({ status: "ask", questions: ["前端组件用哪个？"] }, 6);
    expect(result.kind).toBe("rejected");
    expect(result).toMatchObject({ reasons: [expect.stringContaining("implementation language")] });
  });

  it("refuses to both ask and declare itself done", () => {
    const result = evaluateClarification({ status: "ask", questions: ["谁会用？"], summary: "我懂了" }, 6);
    expect(result.kind).toBe("rejected");
  });

  it("keeps a batch inside the question budget", () => {
    const questions = ["一", "二", "三", "四", "五", "六", "七"].map((n) => `第${n}个问题？`);
    expect(evaluateClarification({ status: "ask", questions }, 6)).toMatchObject({ kind: "rejected" });
    expect(evaluateClarification({ status: "ask", questions: questions.slice(0, 6) }, 6)).toMatchObject({ kind: "ask" });
  });

  it("requires a business-language restatement before moving on", () => {
    expect(evaluateClarification({ status: "ready" }, 6)).toMatchObject({ kind: "rejected" });
    expect(evaluateClarification({ status: "ready", summary: "值班的人要在手机上看到进度" }, 6))
      .toEqual({ kind: "ready", summary: "值班的人要在手机上看到进度" });
  });
});

describe("evaluatePrd", () => {
  it("accepts a PRD whose scenarios a person could judge himself", () => {
    const result = evaluatePrd(REQUIREMENT_ID, {
      businessGoal: "值班的人在手机上就能看到每张卡进行到哪一步",
      nonGoals: ["这次不做权限"],
      scenarios: [scenario(`${REQUIREMENT_ID}-s01`)],
    });
    expect(result).toMatchObject({ kind: "accepted", nonGoals: ["这次不做权限"], openQuestions: [] });
  });

  it("bounces a PRD that describes construction instead of outcome", () => {
    const result = evaluatePrd(REQUIREMENT_ID, {
      businessGoal: "用 react 组件写一个看板",
      scenarios: [scenario(`${REQUIREMENT_ID}-s01`)],
    });
    expect(result).toMatchObject({ kind: "rejected", reasons: [expect.stringContaining("business goal")] });
  });

  it("insists every scenario is identifiable and unique, because acceptance maps one to one", () => {
    const duplicated = evaluatePrd(REQUIREMENT_ID, {
      businessGoal: "值班的人在手机上就能看到每张卡进行到哪一步",
      scenarios: [scenario(`${REQUIREMENT_ID}-s01`), scenario(`${REQUIREMENT_ID}-s01`)],
    });
    expect(duplicated).toMatchObject({ kind: "rejected", reasons: [expect.stringContaining("duplicate scenario id")] });

    const foreign = evaluatePrd(REQUIREMENT_ID, {
      businessGoal: "值班的人在手机上就能看到每张卡进行到哪一步",
      scenarios: [scenario("R-other000000-s01")],
    });
    expect(foreign).toMatchObject({ kind: "rejected" });
  });

  it("refuses a PRD with nothing to accept", () => {
    expect(evaluatePrd(REQUIREMENT_ID, { businessGoal: "让人看到进度", scenarios: [] }))
      .toMatchObject({ kind: "rejected", reasons: [expect.stringContaining("at least one")] });
  });
});
