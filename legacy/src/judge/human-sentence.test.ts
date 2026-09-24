import { describe, expect, it } from "vitest";
import { QUESTION_ID } from "./business-language.js";
import { judgeHumanSentences, unjudgedSentences } from "./human-sentence.js";
import { JudgeError, type SystemOne, type SystemOneRequest } from "./system-one.js";

const OPTIONS = {
  model: "jev-latest",
  threshold: 0.6,
  field: "design-summary",
  what: "这一句写的是怎么实现的",
};

/** All Chinese, no path, no code block, no stack frame: the deterministic
 * linter has nothing to say about it. */
const IMPLEMENTATION_PROSE = "本次改动把缓存层抽出来，复用到三个调用点。";
const OUTCOME = "现在值班的人打开看板，就能一眼看出哪张卡在等他回答。";

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

describe("judgeHumanSentences", () => {
  it("says nothing when no judge is configured", async () => {
    await expect(judgeHumanSentences(undefined, IMPLEMENTATION_PROSE, OPTIONS)).resolves.toEqual([]);
  });

  it("finds the implementation prose the linter is blind to", async () => {
    const findings = await judgeHumanSentences(always(0.97), IMPLEMENTATION_PROSE, OPTIONS);

    expect(findings).toEqual([{ what: OPTIONS.what, excerpt: IMPLEMENTATION_PROSE }]);
  });

  it("leaves a sentence alone when it is not sure", async () => {
    await expect(judgeHumanSentences(always(0.18), IMPLEMENTATION_PROSE, OPTIONS)).resolves.toEqual([]);
  });

  it("never asks about a sentence the linter already objected to", async () => {
    // The linter is the floor: what it flags today it still flags, and a judge
    // that answered these could only take one away.
    const judge = always(0.99);

    await judgeHumanSentences(judge, "This summary is written in English, which the linter already refuses.", OPTIONS);

    expect(judge.asked).toEqual([]);
  });

  it("splits a paragraph into the sentences it judges", async () => {
    const judge = always(0.1);

    await judgeHumanSentences(judge, `${IMPLEMENTATION_PROSE}${OUTCOME}`, OPTIONS);

    expect(judge.asked.map(sentenceOf)).toEqual([IMPLEMENTATION_PROSE, OUTCOME].toSorted());
  });

  it("skips the fragments that are headings and labels rather than sentences", async () => {
    const judge = always(0.99);

    const findings = await judgeHumanSentences(judge, "做完之后：\n好了。\n", OPTIONS);

    expect(judge.asked).toEqual([]);
    expect(findings).toEqual([]);
  });

  it("puts each sentence in a request of its own", async () => {
    const judge = always(0.1);

    await judgeHumanSentences(judge, `${IMPLEMENTATION_PROSE}${OUTCOME}`, OPTIONS);

    for (const request of judge.asked) expect(Object.keys(request.questions)).toHaveLength(1);
  });

  it("asks a sentence repeated in one artifact once", async () => {
    const judge = always(0.1);

    await judgeHumanSentences(judge, `${IMPLEMENTATION_PROSE}${IMPLEMENTATION_PROSE}`, OPTIONS);

    expect(judge.asked).toHaveLength(1);
  });

  it("adds no findings and raises nothing when the judge is unavailable", async () => {
    // The gates this runs on ship whatever they find, so an unreachable judge
    // is one missing finding, not a failure anyone has to handle.
    const broken: SystemOne = {
      async ask() {
        throw new JudgeError("the judge refused the request with 429", "rate_limit");
      },
    };

    await expect(judgeHumanSentences(broken, IMPLEMENTATION_PROSE, OPTIONS)).resolves.toEqual([]);
  });

  it("keeps the answers it got when one sentence fails", async () => {
    const flaky: SystemOne = {
      async ask(request) {
        if (sentenceOf(request) !== IMPLEMENTATION_PROSE) throw new JudgeError("unreachable", "transport");
        return { answers: { [QUESTION_ID]: { type: "noul", noul: 0.95 } } };
      },
    };

    const findings = await judgeHumanSentences(flaky, `${IMPLEMENTATION_PROSE}${OUTCOME}`, OPTIONS);

    expect(findings).toHaveLength(1);
  });

  it("keeps the linter's answer for the sentences an artifact could not hold", async () => {
    const judge = always(0.99);
    const body = Array.from({ length: 30 }, (_index, i) => `这是第 ${i} 句没有被 linter 拦住的话。`).join("");

    await judgeHumanSentences(judge, body, OPTIONS);

    expect(judge.asked).toHaveLength(24);
  });
});

describe("unjudgedSentences", () => {
  it("keeps only what the linter let through, deduplicated and ordered", () => {
    const body = `${OUTCOME}\n参见 src/report/business-language.ts:72 的实现。\n${OUTCOME}`;

    expect(unjudgedSentences("design-summary", body)).toEqual([OUTCOME]);
  });
});
