import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../config/registry.js";
import {
  businessLanguageQuestion,
  judgeBusinessLanguage,
  QUESTION_ID,
  renderRefusedLines,
  unjudgedLines,
} from "./business-language.js";
import { JudgeError, type SystemOne, type SystemOneRequest } from "./system-one.js";

const OPTIONS = { model: "jev-latest", threshold: 0.75 };

/** A wording the seventeen-word table already refuses. */
const TABLE_REFUSES = "先把这个组件的接口定下来";
/** Construction the table cannot see: none of its seventeen words appear. */
const TABLE_MISSES = "引入缓存层以降低响应延迟";

function sentenceOf(request: SystemOneRequest): string {
  return (request.state as { sentence: string }).sentence;
}

function stub(answer: (sentence: string) => number): SystemOne & { asked: SystemOneRequest[] } {
  const asked: SystemOneRequest[] = [];
  return {
    asked,
    async ask(request) {
      asked.push(request);
      return { answers: { [QUESTION_ID]: { type: "noul", noul: answer(sentenceOf(request)) } } };
    },
  };
}

const always = (probability: number) => stub(() => probability);
const line = (text: string, field = "Story S-X-01 requirement") => ({ field, line: 1, text });

describe("judgeBusinessLanguage", () => {
  it("says nothing when no judge is configured", async () => {
    const judgement = await judgeBusinessLanguage(undefined, [line(TABLE_MISSES)], OPTIONS);

    expect(judgement.issues).toEqual([]);
    expect(judgement.moved).toEqual([]);
  });

  it("never asks about a line the word table already refuses", async () => {
    // The table is the floor: every refusal it makes today it still makes, and
    // a judge that answered these could only take one away.
    const judge = always(0.01);

    await judgeBusinessLanguage(judge, [line(TABLE_REFUSES)], OPTIONS);

    expect(judge.asked).toEqual([]);
  });

  it("refuses the construction the table cannot see", async () => {
    const judge = always(0.96);

    const judgement = await judgeBusinessLanguage(judge, [line(TABLE_MISSES)], OPTIONS);

    expect(judgement.issues).toEqual([{
      field: "Story S-X-01 requirement",
      line: 1,
      reason: "describes how the system is built; rewrite it as what a person can do or get",
    }]);
    expect(judgement.moved).toEqual([{ text: TABLE_MISSES, probability: 0.96 }]);
  });

  it("leaves a line alone when it is not sure", async () => {
    // A refusal it invents is not free: the decomposer has two attempts, and
    // the same wrong refusal twice blocks the Epic and costs a person.
    const judgement = await judgeBusinessLanguage(always(0.6), [line(TABLE_MISSES)], OPTIONS);

    expect(judgement.issues).toEqual([]);
  });

  it("puts each line in a request of its own", async () => {
    const judge = always(0.1);

    await judgeBusinessLanguage(judge, [line("第一句"), line("第二句")], OPTIONS);

    expect(judge.asked).toHaveLength(2);
    for (const request of judge.asked) expect(Object.keys(request.questions)).toHaveLength(1);
  });

  it("asks the same line the same way whatever else the plan says", async () => {
    // Measured on the environment question (2026-09-18): asked together, one
    // answer moves with what else is in the batch by an order of magnitude
    // more than it moves between runs. Batched here, one Story's refusal would
    // depend on how its siblings happened to be worded.
    const alone = always(0.1);
    const crowded = always(0.1);

    await judgeBusinessLanguage(alone, [line(TABLE_MISSES)], OPTIONS);
    await judgeBusinessLanguage(crowded, [line(TABLE_MISSES), line("值班的人看到结果"), line("超过三次就提示他")], OPTIONS);

    expect(crowded.asked.find((request) => sentenceOf(request) === TABLE_MISSES)).toEqual(alone.asked[0]);
  });

  it("asks a sentence repeated across Stories once", async () => {
    const judge = always(0.1);

    await judgeBusinessLanguage(judge, [line("同一句"), line("同一句", "Story S-X-02 title"), line("  同一句  ")], OPTIONS);

    expect(judge.asked).toHaveLength(1);
  });

  it("costs the caller its opinion and nothing else when the judge is unavailable", async () => {
    const broken: SystemOne = {
      async ask() {
        throw new JudgeError("the judge refused the request with 429", "rate_limit");
      },
    };

    const judgement = await judgeBusinessLanguage(broken, [line(TABLE_MISSES)], OPTIONS);

    expect(judgement.issues).toEqual([]);
    expect(judgement.error).toContain("rate_limit");
    expect(judgement.skipped).toBe(1);
  });

  it("keeps the answers it got when one question of the plan fails", async () => {
    const answered = TABLE_MISSES;
    const flaky: SystemOne = {
      async ask(request) {
        if (sentenceOf(request) !== answered) throw new JudgeError("the judge could not be reached", "transport");
        return { answers: { [QUESTION_ID]: { type: "noul", noul: 0.94 } } };
      },
    };

    const judgement = await judgeBusinessLanguage(flaky, [line(answered), line("另一句没被表拦住的话")], OPTIONS);

    expect(judgement.issues).toHaveLength(1);
    expect(judgement.error).toContain("1 of 2 unanswered");
  });

  it("keeps the table's answer for the lines a plan could not hold", async () => {
    const judge = always(0.99);
    const many = Array.from({ length: 70 }, (_index, i) => line(`一句没被表拦住的话 ${i}`));

    const judgement = await judgeBusinessLanguage(judge, many, OPTIONS);

    expect(judge.asked).toHaveLength(64);
    expect(judgement.skipped).toBe(6);
  });
});

describe("unjudgedLines", () => {
  it("drops what the table refuses, the blanks and the duplicates", () => {
    expect(unjudgedLines([line(TABLE_REFUSES), line("  "), line("同一句"), line("同一句")]))
      .toEqual([{ field: "Story S-X-01 requirement", line: 1, text: "同一句" }]);
  });
});

describe("renderRefusedLines", () => {
  it("leads with how sure the judge was, so a reader can weigh the line", () => {
    expect(renderRefusedLines([{ text: TABLE_MISSES, probability: 0.961 }])).toBe(`0.96 ${TABLE_MISSES}`);
  });
});

/** Real exchanges, captured 2026-09-18 against the live service. */
const CAPTURED = JSON.parse(
  readFileSync(new URL("../../fixtures/judge/decomposition-lines.json", import.meta.url), "utf8"),
) as {
  exchanges: {
    want: "implementation" | "business";
    note: string;
    request: { state: { sentence: string }; questions: Record<string, unknown> };
    response: { answers: Record<string, { noul: number }> };
  }[];
};

describe("the captured exchanges", () => {
  const threshold = CONFIG_KEYS["judge.businessLanguageThreshold"].default;

  it("were asked the question the code asks today", () => {
    // The threshold below was measured against these wordings. Change the
    // question and the number stops meaning anything, so the fixture has to be
    // recaptured rather than quietly drift away from what is deployed.
    for (const exchange of CAPTURED.exchanges) {
      expect(exchange.request.questions[QUESTION_ID]).toEqual(businessLanguageQuestion());
    }
  });

  it("all land on the right side of the configured threshold", () => {
    for (const exchange of CAPTURED.exchanges) {
      const noul = exchange.response.answers[QUESTION_ID]!.noul;
      const decided = noul >= threshold ? "implementation" : "business";
      expect([exchange.note, decided]).toEqual([exchange.note, exchange.want]);
    }
  });

  it("leaves room between the weakest refusal and the strongest line that must pass", () => {
    // Measured twice over eighteen wordings: construction the table misses
    // scored 0.85-0.96 and lines that must pass 0.03-0.30. The bar sits nearer
    // the top of that gap on purpose -- a refusal it misses costs what happens
    // today, one that it invents can block the Epic.
    const noulOf = (want: string) => CAPTURED.exchanges
      .filter((exchange) => exchange.want === want)
      .map((exchange) => exchange.response.answers[QUESTION_ID]!.noul);

    expect(Math.min(...noulOf("implementation"))).toBeGreaterThan(threshold);
    expect(Math.max(...noulOf("business"))).toBeLessThan(threshold);
  });

  it("does not refuse a product whose own subject matter is technical", () => {
    // The word table's other failure mode, which this question does not fix
    // but must not make worse: the table refuses these on "接口"/"api" and the
    // Epic blocks after two attempts on a requirement that was written right.
    const product = CAPTURED.exchanges.find((exchange) => exchange.note.includes("subject matter is technical"));

    expect(product?.response.answers[QUESTION_ID]!.noul).toBeLessThan(threshold);
  });
});
