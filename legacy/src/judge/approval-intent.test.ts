import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../config/registry.js";
import type { ApprovalSubject } from "./approval-intent.js";
import { approvalQuestion, judgeApprovals, QUESTION_ID, renderMovedApprovals } from "./approval-intent.js";
import { JudgeError, type SystemOne, type SystemOneRequest } from "./system-one.js";

const OPTIONS = { model: "jev-latest", threshold: 0.8 };

function commentOf(request: SystemOneRequest): string {
  return (request.state as { comment: string }).comment;
}

/** Answers by a rule over the one comment each request carries. */
function stub(answer: (comment: string) => number): SystemOne & { asked: SystemOneRequest[] } {
  const asked: SystemOneRequest[] = [];
  return {
    asked,
    async ask(request) {
      asked.push(request);
      return { answers: { [QUESTION_ID]: { type: "noul", noul: answer(commentOf(request)) } } };
    },
  };
}

const always = (probability: number) => stub(() => probability);

describe("judgeApprovals", () => {
  it("says nothing when no judge is configured", async () => {
    const judgement = await judgeApprovals(undefined, ["批准。"], "PRD", OPTIONS);

    expect(judgement.approving.size).toBe(0);
    expect(judgement.moved).toEqual([]);
  });

  it("puts each comment in a request of its own", async () => {
    // Measured on the environment question (2026-09-18): asked together, one
    // answer moves with what else is in the batch by an order of magnitude
    // more than it moves between runs. Batched here, one person's approval
    // would depend on what someone else wrote in the same poll.
    const judge = always(0.1);

    await judgeApprovals(judge, ["确认，可以往下走", "第二条再写细一点"], "PRD", OPTIONS);

    expect(judge.asked).toHaveLength(2);
    for (const request of judge.asked) expect(Object.keys(request.questions)).toHaveLength(1);
  });

  it("asks the same comment the same way whatever else was written that round", async () => {
    const watched = "确认，可以往下走";
    const alone = always(0.1);
    const crowded = always(0.1);

    await judgeApprovals(alone, [watched], "PRD", OPTIONS);
    await judgeApprovals(crowded, [watched, "第二条再写细一点", "这个方案我有疑问"], "PRD", OPTIONS);

    expect(crowded.asked.find((request) => commentOf(request) === watched)).toEqual(alone.asked[0]);
  });

  it("names what is on the page, so the question reads as the person's own", async () => {
    const judge = always(0.1);

    await judgeApprovals(judge, ["行"], "decomposition plan", OPTIONS);

    expect(judge.asked[0]!.questions[QUESTION_ID]!.instructions).toContain("decomposition plan");
    expect(judge.asked[0]!.questions[QUESTION_ID]!.criteria?.false).toContain("decomposition plan");
  });

  it("approves only when the judge is sure enough", async () => {
    const comment = "确认，可以往下走";

    const sure = await judgeApprovals(always(0.91), [comment], "PRD", OPTIONS);
    const unsure = await judgeApprovals(always(0.66), [comment], "PRD", OPTIONS);

    expect([...sure.approving]).toEqual([comment]);
    expect(sure.moved).toEqual([{ body: comment, probability: 0.91 }]);
    // Measured: bare praise sits between 0.55 and 0.76, and reading it as an
    // approval would let unapproved content go on to be built.
    expect(unsure.approving.size).toBe(0);
  });

  it("leaves every comment where the whitelist put it when the judge is unavailable", async () => {
    const broken: SystemOne = {
      async ask() {
        throw new JudgeError("the judge refused the request with 429", "rate_limit");
      },
    };

    const judgement = await judgeApprovals(broken, ["批准。"], "PRD", OPTIONS);

    expect(judgement.approving.size).toBe(0);
    expect(judgement.error).toContain("rate_limit");
    expect(judgement.skipped).toBe(1);
  });

  it("keeps the answers it got when one question of the poll fails", async () => {
    const answered = "确认，可以往下走";
    const flaky: SystemOne = {
      async ask(request) {
        if (commentOf(request) !== answered) throw new JudgeError("the judge could not be reached", "transport");
        return { answers: { [QUESTION_ID]: { type: "noul", noul: 0.93 } } };
      },
    };

    const judgement = await judgeApprovals(flaky, [answered, "行，就这么干"], "PRD", OPTIONS);

    expect([...judgement.approving]).toEqual([answered]);
    expect(judgement.error).toContain("1 of 2 unanswered");
  });

  it("asks a comment repeated on one page once", async () => {
    const judge = always(0.1);

    await judgeApprovals(judge, ["批准。", "批准。", "  批准。  "], "PRD", OPTIONS);

    expect(judge.asked).toHaveLength(1);
  });

  it("keeps the whitelist's answer for the comments a poll could not hold", async () => {
    const judge = always(0.99);
    const many = Array.from({ length: 20 }, (_index, i) => `一条没被识别的回复 ${i}`);

    const judgement = await judgeApprovals(judge, many, "PRD", OPTIONS);

    expect(judge.asked).toHaveLength(16);
    expect(judgement.skipped).toBe(4);
  });
});

describe("renderMovedApprovals", () => {
  it("leads with how sure the judge was, so a reader can weigh the line", () => {
    expect(renderMovedApprovals([{ body: "确认，可以往下走", probability: 0.912 }]))
      .toBe("0.91 确认，可以往下走");
  });
});

/** Real exchanges, captured 2026-09-18 against the live service. */
const CAPTURED = JSON.parse(
  readFileSync(new URL("../../fixtures/judge/approval-comments.json", import.meta.url), "utf8"),
) as {
  exchanges: {
    want: "approval" | "not_approval";
    subject: ApprovalSubject;
    request: { state: { comment: string }; questions: Record<string, { instructions: string }> };
    response: { answers: Record<string, { noul: number }> };
  }[];
};

describe("the captured exchanges", () => {
  const threshold = CONFIG_KEYS["judge.approvalThreshold"].default;

  it("were asked the question the code asks today", () => {
    // The threshold below was measured against these wordings. Change the
    // question and the number stops meaning anything, so the fixture has to be
    // recaptured rather than quietly drift away from what is deployed.
    for (const exchange of CAPTURED.exchanges) {
      expect(exchange.request.questions[QUESTION_ID]).toEqual(approvalQuestion(exchange.subject));
    }
  });

  it("all land on the right side of the configured threshold", () => {
    for (const exchange of CAPTURED.exchanges) {
      const noul = exchange.response.answers[QUESTION_ID]!.noul;
      const decided = noul >= threshold ? "approval" : "not_approval";
      expect([exchange.request.state.comment, decided])
        .toEqual([exchange.request.state.comment, exchange.want]);
    }
  });

  it("leaves room between the weakest approval and the strongest thing that is not one", () => {
    // Measured: the weakest approval is 0.87 and bare praise -- the class the
    // bar exists to exclude -- is 0.55. A threshold outside that gap would
    // either rewrite a draft the person approved or build one they did not.
    const noulOf = (want: string) => CAPTURED.exchanges
      .filter((exchange) => exchange.want === want)
      .map((exchange) => exchange.response.answers[QUESTION_ID]!.noul);

    expect(Math.min(...noulOf("approval"))).toBeGreaterThan(threshold);
    expect(Math.max(...noulOf("not_approval"))).toBeLessThan(threshold);
  });
});
