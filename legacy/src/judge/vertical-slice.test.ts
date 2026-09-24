// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external decomposition contract.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../config/registry.js";
import { JudgeError, type SystemOne, type SystemOneRequest } from "./system-one.js";
import {
  judgeVerticalSlices,
  QUESTION_ID,
  renderRefusedSlices,
  verticalSliceQuestion,
  type JudgedStory,
} from "./vertical-slice.js";

const OPTIONS = { model: "jev-latest", threshold: 0.6 };

function story(id: string, overrides: Partial<JudgedStory> = {}): JudgedStory {
  return {
    id,
    title: "按时间范围追查费用去向",
    requirement: "Ryan 选一个时间范围，看到该范围内的总费用和四个维度的明细。",
    userEntryPoint: "管理后台的「费用」页",
    verificationPath: "打开费用页，选一个时间范围，确认总额对得上",
    scenarios: [{ given: "过去一周产生了费用", when: "Ryan 选中这一周", then: "他看到总额" }],
    ...overrides,
  };
}

function idOf(request: SystemOneRequest): string {
  return ((request.state as { story: { title: string } }).story).title;
}

function stub(answer: (title: string) => number): SystemOne & { asked: SystemOneRequest[] } {
  const asked: SystemOneRequest[] = [];
  return {
    asked,
    async ask(request) {
      asked.push(request);
      return { answers: { [QUESTION_ID]: { type: "noul", noul: answer(idOf(request)) } } };
    },
  };
}

const always = (probability: number) => stub(() => probability);

describe("judgeVerticalSlices", () => {
  it("says nothing when no judge is configured", async () => {
    const judgement = await judgeVerticalSlices(undefined, [story("S-1-01")], OPTIONS);

    expect(judgement.reasons).toEqual([]);
    expect(judgement.moved).toEqual([]);
  });

  it("refuses a Story the judge reads as a step the team takes", async () => {
    const judgement = await judgeVerticalSlices(always(0.91), [story("S-1-01")], OPTIONS);

    expect(judgement.moved).toEqual([{ storyId: "S-1-01", probability: 0.91 }]);
    expect(judgement.reasons[0]).toContain("S-1-01");
    expect(judgement.reasons[0]).toContain("Re-split the Epic");
  });

  it("leaves a Story alone when it is not sure", async () => {
    // Indifference sits near 0.5, and refusing on that would turn every shrug
    // into a blocked Epic: the decomposer has two attempts and feeds each
    // refusal into the next.
    const judgement = await judgeVerticalSlices(always(0.54), [story("S-1-01")], OPTIONS);

    expect(judgement.reasons).toEqual([]);
  });

  it("sends only the fields a person would read", async () => {
    const judge = always(0.1);

    await judgeVerticalSlices(judge, [story("S-1-01")], OPTIONS);

    expect(judge.asked[0]!.state).toEqual({
      story: {
        title: "按时间范围追查费用去向",
        requirement: "Ryan 选一个时间范围，看到该范围内的总费用和四个维度的明细。",
        userEntryPoint: "管理后台的「费用」页",
        verificationPath: "打开费用页，选一个时间范围，确认总额对得上",
        scenarios: [{ given: "过去一周产生了费用", when: "Ryan 选中这一周", then: "他看到总额" }],
      },
    });
  });

  it("puts each Story in a request of its own", async () => {
    const judge = always(0.1);

    await judgeVerticalSlices(judge, [story("S-1-01"), story("S-1-02", { title: "另一件事" })], OPTIONS);

    expect(judge.asked).toHaveLength(2);
    for (const request of judge.asked) expect(Object.keys(request.questions)).toHaveLength(1);
  });

  it("asks the same Story the same way whatever its siblings look like", async () => {
    // Every Story in a plan is about the same feature, so siblings are exactly
    // the distractor batching would introduce: a thin slice beside five
    // thinner ones would not score as it does beside five fat ones.
    const watched = story("S-1-01");
    const alone = always(0.1);
    const crowded = always(0.1);

    await judgeVerticalSlices(alone, [watched], OPTIONS);
    await judgeVerticalSlices(crowded, [
      watched,
      story("S-1-02", { title: "费用数据的存储结构" }),
      story("S-1-03", { title: "费用页面骨架" }),
    ], OPTIONS);

    expect(crowded.asked.find((request) => idOf(request) === watched.title)).toEqual(alone.asked[0]);
  });

  it("asks in Story id order, so one plan produces one sequence of requests", async () => {
    const judge = always(0.1);

    await judgeVerticalSlices(judge, [
      story("S-1-03", { title: "丙" }),
      story("S-1-01", { title: "甲" }),
      story("S-1-02", { title: "乙" }),
    ], OPTIONS);

    expect(judge.asked.map(idOf)).toEqual(["甲", "乙", "丙"]);
  });

  it("costs the caller its opinion and nothing else when the judge is unavailable", async () => {
    const broken: SystemOne = {
      async ask() {
        throw new JudgeError("the judge refused the request with 429", "rate_limit");
      },
    };

    const judgement = await judgeVerticalSlices(broken, [story("S-1-01")], OPTIONS);

    expect(judgement.reasons).toEqual([]);
    expect(judgement.error).toContain("rate_limit");
    expect(judgement.skipped).toBe(1);
  });

  it("keeps the answers it got when one question of the plan fails", async () => {
    const flaky: SystemOne = {
      async ask(request) {
        if (idOf(request) !== "甲") throw new JudgeError("the judge could not be reached", "transport");
        return { answers: { [QUESTION_ID]: { type: "noul", noul: 0.9 } } };
      },
    };

    const judgement = await judgeVerticalSlices(flaky, [
      story("S-1-01", { title: "甲" }),
      story("S-1-02", { title: "乙" }),
    ], OPTIONS);

    expect(judgement.moved).toHaveLength(1);
    expect(judgement.error).toContain("1 of 2 unanswered");
  });

  it("keeps the checks' answer for the Stories a plan could not hold", async () => {
    const judge = always(0.99);
    const many = Array.from({ length: 20 }, (_index, i) => story(`S-1-${String(i).padStart(2, "0")}`));

    const judgement = await judgeVerticalSlices(judge, many, OPTIONS);

    expect(judge.asked).toHaveLength(16);
    expect(judgement.skipped).toBe(4);
  });
});

describe("renderRefusedSlices", () => {
  it("names the Stories and how sure the judge was about each", () => {
    expect(renderRefusedSlices([{ storyId: "S-1-01", probability: 0.912 }])).toBe("0.91 S-1-01");
  });
});

/** Real exchanges, captured 2026-09-18 against the live service. */
const CAPTURED = JSON.parse(
  readFileSync(new URL("../../fixtures/judge/decomposition-slices.json", import.meta.url), "utf8"),
) as {
  exchanges: {
    want: "step" | "slice";
    note: string;
    expectRefused: boolean;
    request: { questions: Record<string, unknown> };
    response: { answers: Record<string, { noul: number }> };
  }[];
};

const noulOf = (exchange: { response: { answers: Record<string, { noul: number }> } }): number =>
  exchange.response.answers[QUESTION_ID]!.noul;

describe("the captured exchanges", () => {
  const threshold = CONFIG_KEYS["judge.verticalSliceThreshold"].default;

  it("were asked the question the code asks today", () => {
    // Three phrasings of this question were measured and two discarded: the
    // same Stories moved by up to 0.54 between them, against 0.03 of
    // run-to-run noise. The threshold means nothing apart from this wording,
    // so a change to it has to recapture rather than drift.
    for (const exchange of CAPTURED.exchanges) {
      expect(exchange.request.questions[QUESTION_ID]).toEqual(verticalSliceQuestion());
    }
  });

  it("refuses what the bar is set to refuse and passes the rest", () => {
    for (const exchange of CAPTURED.exchanges) {
      expect([exchange.note, noulOf(exchange) >= threshold]).toEqual([exchange.note, exchange.expectRefused]);
    }
  });

  it("never refuses a thing a person does", () => {
    // The expensive mistake: two of these are the ones most easily read as
    // plumbing -- signing in with a company account, and a product whose own
    // customers are developers -- and refusing either would block the Epic.
    for (const exchange of CAPTURED.exchanges.filter((entry) => entry.want === "slice")) {
      expect([exchange.note, noulOf(exchange) < threshold]).toEqual([exchange.note, true]);
    }
  });

  it("lets the one borderline shape through, on purpose", () => {
    // A Story that is nothing but an interface other code calls scores 0.54 to
    // 0.59: the judge is genuinely unsure, so the bar leaves it to the humans
    // rather than block an Epic on a coin flip. Missing it costs today's
    // behaviour, which is the cheap direction.
    const borderline = CAPTURED.exchanges.find((exchange) => exchange.note.includes("borderline"));

    expect(borderline?.want).toBe("step");
    expect(noulOf(borderline!)).toBeLessThan(threshold);
    expect(noulOf(borderline!)).toBeGreaterThan(0.5);
  });
});
