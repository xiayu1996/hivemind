import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitScenarioFailures } from "../pipeline/failure-classification.js";
import {
  judgeEnvironmentReasons,
  QUESTION_ID,
  renderMovedReasons,
  unmatchedReasons,
} from "./environment-reasons.js";
import { JudgeError, type SystemOne, type SystemOneRequest } from "./system-one.js";

/** A refusal the pattern table already recognises, captured from the round it
 * was added for (S-E2RESULTS-01 r12). */
const CAPTURED_ENVIRONMENT_REASON = (JSON.parse(
  readFileSync(new URL("../../fixtures/verify-reasons/browser-connection-refused.json", import.meta.url), "utf8"),
) as { reasons: { reason: string }[] }).reasons[0]!.reason;

const OPTIONS = { model: "jev-latest", threshold: 0.7 };

function reasonOf(request: SystemOneRequest): string {
  return (request.state as { reason: string }).reason;
}

/** Answers by a rule over the one reason each request carries. */
function stub(answer: (reason: string) => number): SystemOne & { asked: SystemOneRequest[] } {
  const asked: SystemOneRequest[] = [];
  return {
    asked,
    async ask(request) {
      asked.push(request);
      return { answers: { [QUESTION_ID]: { type: "noul", noul: answer(reasonOf(request)) } } };
    },
  };
}

const always = (probability: number) => stub(() => probability);

describe("judgeEnvironmentReasons", () => {
  it("says nothing when no judge is configured", async () => {
    const judgement = await judgeEnvironmentReasons(undefined, ["the dev server never started"], OPTIONS);

    expect(judgement.environmental.size).toBe(0);
    expect(judgement.moved).toEqual([]);
  });

  it("never asks about a reason the pattern table already recognises", async () => {
    // The table is the floor: every split it decides today it still decides,
    // and a judge that answered these could only take one away.
    const judge = always(0.99);

    await judgeEnvironmentReasons(judge, [CAPTURED_ENVIRONMENT_REASON], OPTIONS);

    expect(judge.asked).toEqual([]);
  });

  it("asks only about what fell through the table", async () => {
    const judge = always(0.99);
    const missed = "the harness the reviewer started answered with an empty body";

    await judgeEnvironmentReasons(judge, [CAPTURED_ENVIRONMENT_REASON, missed], OPTIONS);

    expect(judge.asked).toHaveLength(1);
    expect(judge.asked[0]!.state).toEqual({ reason: missed });
    expect(Object.keys(judge.asked[0]!.questions)).toEqual([QUESTION_ID]);
  });

  it("puts each reason in a request of its own", async () => {
    const judge = always(0.1);

    await judgeEnvironmentReasons(judge, ["a could not reach the fixture host", "b lost the seeded database"], OPTIONS);

    expect(judge.asked).toHaveLength(2);
    for (const request of judge.asked) expect(Object.keys(request.questions)).toHaveLength(1);
  });

  it("asks the same reason the same way whatever else failed in that round", async () => {
    // Measured 2026-09-18: asked together, one reason's answer moves by up to
    // 0.29 with what else is in the batch, against 0.02 of run-to-run noise.
    // Batching would make a scenario's verdict depend on which siblings
    // happened to fail beside it.
    const watched = "the stand-in the reviewer started stopped responding partway through";
    const alone = always(0.1);
    const crowded = always(0.1);

    await judgeEnvironmentReasons(alone, [watched], OPTIONS);
    await judgeEnvironmentReasons(crowded, [watched, "the total was 0 instead of 3", "the export button was missing"], OPTIONS);

    const asked = crowded.asked.find((request) => reasonOf(request) === watched);
    expect(asked).toEqual(alone.asked[0]);
  });

  it("asks a reason repeated across scenarios once", async () => {
    const judge = always(0.1);
    const repeated = "a could not reach the fixture host";

    await judgeEnvironmentReasons(judge, [repeated, repeated, repeated], OPTIONS);

    expect(judge.asked).toHaveLength(1);
  });

  it("moves a reason only when the judge is sure enough", async () => {
    const reason = "the page the reviewer opened came from a build that is not this worktree";

    const sure = await judgeEnvironmentReasons(always(0.92), [reason], OPTIONS);
    const unsure = await judgeEnvironmentReasons(always(0.55), [reason], OPTIONS);

    expect([...sure.environmental]).toEqual([reason]);
    expect(sure.moved).toEqual([{ reason, probability: 0.92 }]);
    expect(unsure.environmental.size).toBe(0);
  });

  it("costs the caller its opinion and nothing else when the judge is unavailable", async () => {
    const broken: SystemOne = {
      async ask() {
        throw new JudgeError("the judge refused the request with 429", "rate_limit");
      },
    };

    const judgement = await judgeEnvironmentReasons(broken, ["the port was held by something else"], OPTIONS);

    expect(judgement.environmental.size).toBe(0);
    expect(judgement.error).toContain("rate_limit");
    expect(judgement.skipped).toBe(1);
  });

  it("keeps the answers it got when one question of the round fails", async () => {
    // One request per reason means one failure is one lost opinion, not a lost
    // round: the rest are already on the wire.
    const answered = "the seeded host refused the connection";
    const flaky: SystemOne = {
      async ask(request) {
        const reason = reasonOf(request);
        if (reason !== answered) throw new JudgeError("the judge could not be reached", "transport");
        return { answers: { [QUESTION_ID]: { type: "noul", noul: 0.94 } } };
      },
    };

    const judgement = await judgeEnvironmentReasons(flaky, [answered, "the browser would not launch here"], OPTIONS);

    expect([...judgement.environmental]).toEqual([answered]);
    expect(judgement.error).toContain("1 of 2 unanswered");
  });

  it("keeps the table's answer for the reasons a round could not hold", async () => {
    const judge = always(0.99);
    const many = Array.from({ length: 20 }, (_index, i) => `an unrecognised refusal number ${i}`);

    const judgement = await judgeEnvironmentReasons(judge, many, OPTIONS);

    expect(judge.asked).toHaveLength(16);
    expect(judgement.skipped).toBe(4);
  });
});

describe("the judged split", () => {
  const reasons = [
    // Deliberately worded the way a reviewer writes it and the way the pattern
    // table does not recognise: no errno, no status code, no runner format.
    { scenarioId: "S-1-a", reason: "the reviewer's own stub crashed before it could serve the page" },
    { scenarioId: "S-1-b", reason: "the total shown on the summary row was 0 instead of 3" },
  ];

  it("counts a scenario against convergence when nobody judged its refusal", async () => {
    const judgement = await judgeEnvironmentReasons(undefined, reasons.map((entry) => entry.reason), OPTIONS);

    const split = splitScenarioFailures(["S-1-a", "S-1-b"], reasons, judgement.environmental);

    expect(split.code).toEqual(["S-1-a", "S-1-b"]);
  });

  it("stops counting the scenario the judge attributed to the box", async () => {
    const judge = stub((reason) => (reason.includes("stub") ? 0.97 : 0.02));

    const judgement = await judgeEnvironmentReasons(judge, reasons.map((entry) => entry.reason), OPTIONS);
    const split = splitScenarioFailures(["S-1-a", "S-1-b"], reasons, judgement.environmental);

    expect(split.environment).toEqual(["S-1-a"]);
    expect(split.code).toEqual(["S-1-b"]);
  });
});

describe("unmatchedReasons", () => {
  it("drops the duplicates a round repeats across its scenarios", () => {
    expect(unmatchedReasons(["same refusal", "same refusal", CAPTURED_ENVIRONMENT_REASON])).toEqual(["same refusal"]);
  });
});

describe("renderMovedReasons", () => {
  it("leads with how sure the judge was, so a reader can weigh the line", () => {
    expect(renderMovedReasons([{ reason: "the seeded host refused the connection", probability: 0.934 }]))
      .toBe("0.93 the seeded host refused the connection");
  });
});
