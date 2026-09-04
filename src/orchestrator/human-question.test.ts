import { describe, expect, it } from "vitest";
import {
  annotateReply,
  inspectQuestion,
  normalizeQuestion,
  numberedQuestions,
  parseQuestions,
  questionText,
  replyHint,
  resolveChoices,
  type HumanQuestion,
} from "./human-question.js";

const audience: HumanQuestion = {
  question: "这批功能面向哪些客户？",
  context: "付费与免费客户的验收场景完全不同。",
  options: [{ label: "只面向已付费的企业客户", recommended: true }, { label: "所有注册客户" }],
};
const cadence: HumanQuestion = {
  question: "多久需要看到一次更新？",
  options: [{ label: "实时" }, { label: "每天一次" }, { label: "每周一次" }],
};
const open: HumanQuestion = { question: "现在这件事是怎么解决的？", options: [] };

describe("normalizeQuestion", () => {
  it("turns a bare sentence into an open question and trims what a model padded", () => {
    expect(normalizeQuestion("  谁会用它？ ")).toEqual({ question: "谁会用它？", options: [] });
    expect(normalizeQuestion({ question: " 谁会用它？", context: " ", options: [{ label: " 值班的人 " }, { label: "" }] }))
      .toEqual({ question: "谁会用它？", options: [{ label: "值班的人" }] });
  });
});

describe("inspectQuestion", () => {
  it("accepts a question with a recommended option and a free-text fallback", () => {
    expect(inspectQuestion("question 1", audience)).toEqual([]);
    expect(inspectQuestion("question 2", open)).toEqual([]);
  });

  it("refuses shapes a person cannot answer with one letter", () => {
    expect(inspectQuestion("q", { ...open, options: [{ label: "唯一" }] })).toEqual([
      "q offers a single option; offer at least two or none",
    ]);
    expect(inspectQuestion("q", { ...cadence, options: cadence.options.map((option) => ({ ...option, recommended: true })) }))
      .toEqual(["q recommends more than one option"]);
    expect(inspectQuestion("q", { ...open, options: [{ label: "实时" }, { label: "实时" }] })).toEqual(["q repeats option: 实时"]);
  });

  it("holds options to the same business-language rule as the question", () => {
    const reasons = inspectQuestion("q", { ...open, options: [{ label: "走 api 推送" }, { label: "每天一次" }] });
    expect(reasons).toEqual([expect.stringContaining("implementation language")]);
  });
});

describe("rendering", () => {
  it("lists lettered options under the question with the recommendation marked and a way out", () => {
    expect(questionText(audience).split("\n")).toEqual([
      "这批功能面向哪些客户？",
      "背景：付费与免费客户的验收场景完全不同。",
      "A. 只面向已付费的企业客户（推荐）",
      "B. 所有注册客户",
      "其他：以上都不合适，直接写你的答案",
    ]);
    expect(questionText(open)).toBe("现在这件事是怎么解决的？");
  });

  it("numbers a batch and indents each question's options under it", () => {
    expect(numberedQuestions([open, cadence])).toEqual([
      "1. 现在这件事是怎么解决的？",
      "2. 多久需要看到一次更新？",
      "   A. 实时",
      "   B. 每天一次",
      "   C. 每周一次",
      "   其他：以上都不合适，直接写你的答案",
    ]);
  });

  it("tells the person how to reply in the shape that was asked", () => {
    expect(replyHint([open])).toContain("按序号回答");
    expect(replyHint([audience])).toContain("如 A");
    expect(replyHint([audience, cadence])).toContain("1A 2B");
  });
});

describe("resolveChoices", () => {
  it("reads a bare letter as the answer to a single question", () => {
    expect(resolveChoices([audience], "B")).toEqual([{ questionIndex: 0, optionIndex: 1, label: "所有注册客户" }]);
    expect(resolveChoices([audience], "选 a，另外周末不上线")).toMatchObject([{ optionIndex: 0 }]);
  });

  it("pairs numbers with questions and letters with options in a batch reply", () => {
    expect(resolveChoices([audience, cadence], "1A 2C")).toMatchObject([
      { questionIndex: 0, optionIndex: 0 },
      { questionIndex: 1, optionIndex: 2 },
    ]);
    expect(resolveChoices([audience, cadence], "问 1：B\nQ2. a")).toMatchObject([
      { questionIndex: 0, optionIndex: 1 },
      { questionIndex: 1, optionIndex: 0 },
    ]);
  });

  it("leaves prose, out-of-range letters and open questions alone", () => {
    expect(resolveChoices([audience], "A/B testing is what we call it")).toEqual([]);
    expect(resolveChoices([audience], "C")).toEqual([]);
    expect(resolveChoices([open], "A")).toEqual([]);
    expect(resolveChoices([audience, cadence], "2 楼的人说要 A4 纸")).toEqual([]);
  });

  it("does not read a bare letter as an answer when several questions were asked", () => {
    expect(resolveChoices([audience, cadence], "A")).toEqual([]);
  });
});

describe("annotateReply", () => {
  it("keeps the reply verbatim and appends what the letters meant", () => {
    expect(annotateReply([audience], "A")).toBe("A\n（系统解读：选 A = 只面向已付费的企业客户）");
    expect(annotateReply([audience, cadence], "1B，2 选 B，另外想要导出"))
      .toBe("1B，2 选 B，另外想要导出\n（系统解读：问 1 选 B = 所有注册客户；问 2 选 B = 每天一次）");
    expect(annotateReply([audience], "先只做内部员工")).toBe("先只做内部员工");
  });
});

describe("parseQuestions", () => {
  it("reads rows written before questions had options as open questions", () => {
    expect(parseQuestions(JSON.stringify(["谁会用它？"]), "questions")).toEqual([{ question: "谁会用它？", options: [] }]);
    expect(parseQuestions(JSON.stringify([audience]), "questions")).toEqual([audience]);
    expect(() => parseQuestions(JSON.stringify([1]), "questions")).toThrow(/not an array of questions/);
  });
});
