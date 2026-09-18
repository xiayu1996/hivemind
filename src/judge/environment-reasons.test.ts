import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitScenarioFailures } from "../pipeline/failure-classification.js";
import { judgeEnvironmentReasons, renderMovedReasons, unmatchedReasons } from "./environment-reasons.js";
import { JudgeError, type SystemOne, type SystemOneRequest } from "./system-one.js";

/** A refusal the pattern table already recognises, captured from the round it
 * was added for (S-E2RESULTS-01 r12). */
const CAPTURED_ENVIRONMENT_REASON = (JSON.parse(
  readFileSync(new URL("../../fixtures/verify-reasons/browser-connection-refused.json", import.meta.url), "utf8"),
) as { reasons: { reason: string }[] }).reasons[0]!.reason;

const OPTIONS = { model: "jev-latest", threshold: 0.85 };

/** Answers every question with the same probability and records what it saw. */
function stub(probability: number): SystemOne & { asked: SystemOneRequest[] } {
  const asked: SystemOneRequest[] = [];
  return {
    asked,
    async ask(request) {
      asked.push(request);
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul: probability }]),
        ),
      };
    },
  };
}

describe("judgeEnvironmentReasons", () => {
  it("says nothing when no judge is configured", async () => {
    const judgement = await judgeEnvironmentReasons(undefined, ["the dev server never started"], OPTIONS);

    expect(judgement.environmental.size).toBe(0);
    expect(judgement.moved).toEqual([]);
  });

  it("never asks about a reason the pattern table already recognises", async () => {
    // The table is the floor: every split it decides today it still decides,
    // and a judge that answered these could only take one away.
    const judge = stub(0.99);

    await judgeEnvironmentReasons(judge, [CAPTURED_ENVIRONMENT_REASON], OPTIONS);

    expect(judge.asked).toEqual([]);
  });

  it("asks only about what fell through the table", async () => {
    const judge = stub(0.99);

    await judgeEnvironmentReasons(
      judge,
      [CAPTURED_ENVIRONMENT_REASON, "the harness the reviewer started answered with an empty body"],
      OPTIONS,
    );

    expect(judge.asked).toHaveLength(1);
    expect(judge.asked[0]!.state).toEqual({
      reasons: ["the harness the reviewer started answered with an empty body"],
    });
    expect(Object.keys(judge.asked[0]!.questions)).toEqual(["reason_0"]);
  });

  it("moves a reason only when the judge is sure enough", async () => {
    const reason = "the page the reviewer opened came from a build that is not this worktree";

    const sure = await judgeEnvironmentReasons(stub(0.92), [reason], OPTIONS);
    const unsure = await judgeEnvironmentReasons(stub(0.7), [reason], OPTIONS);

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

  it("asks the same round the same question twice over", async () => {
    // Two runs of the same round have to produce the same bytes: the provider
    // caches on them, and so does anyone comparing two runs side by side.
    const first = stub(0.1);
    const second = stub(0.1);
    const reasons = ["b failed to connect to the seeded database", "a could not reach the fixture host", "a could not reach the fixture host"];

    await judgeEnvironmentReasons(first, reasons, OPTIONS);
    await judgeEnvironmentReasons(second, [...reasons].toReversed(), OPTIONS);

    expect(first.asked[0]).toEqual(second.asked[0]);
    expect((first.asked[0]!.state as { reasons: string[] }).reasons).toHaveLength(2);
  });

  it("keeps the table's answer for the reasons a single call could not hold", async () => {
    const judge = stub(0.99);
    const many = Array.from({ length: 20 }, (_index, i) => `an unrecognised refusal number ${i}`);

    const judgement = await judgeEnvironmentReasons(judge, many, OPTIONS);

    expect(judge.asked[0]!.questions).toHaveProperty("reason_15");
    expect(judge.asked[0]!.questions).not.toHaveProperty("reason_16");
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
    const judge: SystemOne = {
      async ask(request) {
        const asked = (request.state as { reasons: string[] }).reasons;
        return {
          answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [
            id,
            { type: "noul" as const, noul: asked[index]!.includes("stub") ? 0.97 : 0.02 },
          ])),
        };
      },
    };

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
