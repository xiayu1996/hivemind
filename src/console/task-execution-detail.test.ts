import { describe, expect, it } from "vitest";
import * as detailModule from "./task-execution-detail.js";
import type {
  TaskExecutionDetail,
  TaskExecutionProjectionInput,
  TaskRoundObservation,
} from "./task-execution-detail.js";

function project(input: TaskExecutionProjectionInput): TaskExecutionDetail {
  expect(detailModule.projectTaskExecutionDetail).toBeTypeOf("function");
  return detailModule.projectTaskExecutionDetail(input);
}

function observation(input: Partial<TaskRoundObservation> & Pick<TaskRoundObservation, "round" | "phase" | "startedAt" | "progress">): TaskRoundObservation {
  return {
    runStatus: "completed",
    outputs: [],
    ...input,
  };
}

describe("task execution detail projection", () => {
  it("@scenario S-TRACE02-01-timeline orders three rounds and their complete records from oldest to newest", () => {
    const detail = project({
      taskId: "S-TRACE02-01",
      taskName: "Round-by-round execution detail",
      observedAt: 1_000,
      observations: [
        observation({
          round: 3,
          phase: "VERIFY",
          startedAt: 330,
          progress: "Round 3 verified",
          outputs: [{ phase: "VERIFY", kind: "verification", content: "Round 3 result", createdAt: 340 }],
          verification: { verdict: "accepted", result: "Round 3 accepted" },
        }),
        observation({
          round: 1,
          phase: "VERIFY",
          startedAt: 130,
          progress: "Round 1 verified",
          outputs: [{ phase: "VERIFY", kind: "verification", content: "Round 1 result", createdAt: 140 }],
          verification: { verdict: "accepted", result: "Round 1 accepted" },
        }),
        observation({
          round: 2,
          phase: "VERIFY",
          startedAt: 230,
          progress: "Round 2 verified",
          outputs: [{ phase: "VERIFY", kind: "verification", content: "Round 2 result", createdAt: 240 }],
          verification: { verdict: "accepted", result: "Round 2 accepted" },
        }),
        observation({
          round: 1,
          phase: "CODE",
          startedAt: 110,
          progress: "Round 1 implementation complete",
          outputs: [
            { phase: "CODE", kind: "late", content: "Round 1 later output", createdAt: 125 },
            { phase: "CODE", kind: "early", content: "Round 1 early output", createdAt: 115 },
          ],
        }),
      ],
    });

    expect(detail.rounds.map((round) => round.round)).toEqual([1, 2, 3]);
    expect(detail.rounds[0]).toMatchObject({
      process: [
        { phase: "CODE", summary: "Round 1 implementation complete", occurredAt: 110 },
        { phase: "VERIFY", summary: "Round 1 verified", occurredAt: 130 },
      ],
      outputs: [
        { kind: "early", content: "Round 1 early output", createdAt: 115 },
        { kind: "late", content: "Round 1 later output", createdAt: 125 },
        { kind: "verification", content: "Round 1 result", createdAt: 140 },
      ],
      currentResult: "Round 1 accepted",
    });
    expect(detail.rounds.map((round) => round.currentResult)).toEqual([
      "Round 1 accepted",
      "Round 2 accepted",
      "Round 3 accepted",
    ]);
  });

  it("@scenario S-TRACE02-01-timeline groups repeated observations into one positive round without dropping process or output", () => {
    const detail = project({
      taskId: "S-TRACE02-01",
      taskName: "Round-by-round execution detail",
      observedAt: 1_000,
      observations: [
        observation({
          round: 1,
          phase: "CODE",
          startedAt: 10,
          progress: "Implementation complete",
          outputs: [{ phase: "CODE", kind: "code", content: "Implementation output", createdAt: 11 }],
        }),
        observation({
          round: 1,
          phase: "VERIFY",
          startedAt: 20,
          progress: "Verification complete",
          outputs: [{ phase: "VERIFY", kind: "evidence", content: "Verification output", createdAt: 21 }],
          verification: { verdict: "accepted", result: "Accepted" },
        }),
      ],
    });

    expect(detail.rounds).toHaveLength(1);
    expect(detail.rounds[0]?.round).toBe(1);
    expect(detail.rounds[0]?.process).toHaveLength(2);
    expect(detail.rounds[0]?.outputs.map((output) => output.content)).toEqual([
      "Implementation output",
      "Verification output",
    ]);
  });

  it("@scenario S-TRACE02-01-statuses exposes completed, failed and running states with the persisted reason and latest progress", () => {
    const detail = project({
      taskId: "S-TRACE02-01",
      taskName: "Round-by-round execution detail",
      observedAt: 1_000,
      observations: [
        observation({
          round: 1,
          phase: "VERIFY",
          startedAt: 100,
          progress: "Verification passed",
          verification: { verdict: "accepted", result: "All acceptance scenarios passed" },
        }),
        observation({
          round: 2,
          phase: "VERIFY",
          startedAt: 200,
          progress: "Verification did not pass",
          verification: {
            verdict: "rejected",
            result: "One acceptance scenario failed",
            failureReason: "The detail included records from another task",
          },
        }),
        observation({
          round: 3,
          phase: "CODE",
          runStatus: "running",
          startedAt: 300,
          progress: "Preparing acceptance evidence",
        }),
      ],
    });

    expect(detail.rounds).toEqual([
      expect.objectContaining({ round: 1, status: "completed", currentResult: "All acceptance scenarios passed" }),
      expect.objectContaining({
        round: 2,
        status: "failed",
        currentResult: "One acceptance scenario failed",
        failureReason: "The detail included records from another task",
      }),
      expect.objectContaining({ round: 3, status: "running", currentResult: "Preparing acceptance evidence" }),
    ]);
    expect("failureReason" in (detail.rounds[0] ?? {})).toBe(false);
    expect("failureReason" in (detail.rounds[2] ?? {})).toBe(false);
  });

  it("@scenario S-TRACE02-01-statuses keeps a terminal failure when a later active observation exists and never invents a reason", () => {
    const detail = project({
      taskId: "S-TRACE02-01",
      taskName: "Round-by-round execution detail",
      observedAt: 1_000,
      observations: [
        observation({
          round: 2,
          phase: "VERIFY",
          startedAt: 200,
          progress: "Verification failed",
          verification: {
            verdict: "inconclusive",
            result: "Evidence was incomplete",
            failureReason: "The browser evidence did not contain the selected task number",
          },
        }),
        observation({
          round: 2,
          phase: "CODE",
          runStatus: "running",
          startedAt: 210,
          progress: "A follow-up process is still active",
        }),
      ],
    });

    expect(detail.rounds).toHaveLength(1);
    expect(detail.rounds[0]).toMatchObject({
      status: "failed",
      currentResult: "Evidence was incomplete",
      failureReason: "The browser evidence did not contain the selected task number",
    });
  });
});
