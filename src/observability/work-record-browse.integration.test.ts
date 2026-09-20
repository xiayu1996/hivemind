import { describe, expect, it } from "vitest";
import * as workRecordReader from "./work-record-reader.js";
import {
  createWorkRecordReader,
  type WorkRecordDetail,
  type WorkRecordDetailResult,
  type WorkRecordSource,
  type WorkRecordSourceRun,
  type WorkRecordSourceStep,
} from "./work-record-reader.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;

function run(
  runId: string,
  role: string,
  status: WorkRecordSourceRun["status"],
  startedAt = NOW - 3 * DAY,
): WorkRecordSourceRun {
  return {
    runId,
    role,
    name: `${role} periodic optimization`,
    requirement: { id: `R-${runId}`, title: `Requirement ${runId}` },
    startedAt,
    status,
  };
}

function step(runId: string, sequence: number, occurredAt: number, text: string): WorkRecordSourceStep {
  return { runId, sequence, occurredAt, kind: "action", text, visibility: "display" };
}

function source(
  runs: readonly WorkRecordSourceRun[],
  steps: Readonly<Record<string, readonly WorkRecordSourceStep[]>>,
): WorkRecordSource {
  return {
    loadRuns: async () => runs,
    loadSteps: async (runId, afterSequence) => (steps[runId] ?? [])
      .filter((candidate) => afterSequence === undefined || candidate.sequence > afterSequence),
  };
}

function runningDetail(runId: string, throughSequence: number): WorkRecordDetail {
  return {
    runId,
    role: "engineer",
    name: "Periodic optimization",
    requirement: { id: "R-live", title: "Live work" },
    startedAt: NOW - 120_000,
    status: { kind: "running", refreshAfterMs: 5_000 },
    steps: Array.from({ length: throughSequence }, (_, index) => ({
      runId,
      sequence: index + 1,
      occurredAt: NOW - 120_000 + index * 30_000,
      kind: index === 0 ? "start" : "action",
      text: { value: `event ${index + 1}`, redaction: "applied" },
    })),
    throughSequence,
  };
}

describe("work record activity browsing", () => {
  it("@scenario S-R237511TR-02-recent \u7a7a\u5173\u952e\u8bcd\u6309\u6700\u8fd1\u8bb0\u5f55\u65f6\u95f4\u5c55\u793a\u6700\u8fd1\u4e8c\u5341\u56db\u5c0f\u65f6\u5185\u5168\u90e8\u89d2\u8272\u7684\u5de5\u4f5c", async () => {
    const prototype = run("prototype", "prototype", {
      kind: "stopped",
      outcome: "completed",
      stoppedAt: NOW - 30_000,
    });
    const engineer = run("engineer", "engineer", { kind: "running", refreshAfterMs: 5_000 });
    const reader = createWorkRecordReader(source(
      [prototype, engineer],
      {
        prototype: [step("prototype", 1, NOW - 60_000, "prototype update")],
        engineer: [step("engineer", 1, NOW - 120_000, "engineer update")],
      },
    ), { now: () => NOW });

    const search = reader.search({ keyword: "", fromInclusive: NOW - DAY, toExclusive: NOW });

    await expect(search).resolves.toMatchObject({ query: { keyword: "" } });
    const result = await search;
    expect(result.query.keyword).toBe("");
    expect(result.matches.map((match) => [match.runId, match.occurredAt, match.role])).toEqual([
      ["prototype", NOW - 60_000, "prototype"],
      ["engineer", NOW - 120_000, "engineer"],
    ]);
    expect(result.matches.map((match) => match.status)).toEqual([
      { kind: "stopped", outcome: "completed", stoppedAt: NOW - 30_000 },
      { kind: "running" },
    ]);
    expect(result.matches.every((match) => match.hit.length === 0)).toBe(true);
  });

  it("@scenario S-R237511TR-02-recent \u7a97\u53e3\u8d77\u70b9\u5305\u542b\u800c\u7ec8\u70b9\u6392\u9664\u4e14\u4e24\u5929\u524d\u65e0\u65b0\u8bb0\u5f55\u7684\u5de5\u4f5c\u4e0d\u51fa\u73b0", async () => {
    const reader = createWorkRecordReader(source(
      [
        run("at-start", "engineer", { kind: "running", refreshAfterMs: 5_000 }),
        run("at-end", "prototype", { kind: "running", refreshAfterMs: 5_000 }),
        run("stale", "engineer", { kind: "stopped", outcome: "completed", stoppedAt: NOW - 2 * DAY }),
      ],
      {
        "at-start": [step("at-start", 1, NOW - DAY, "included")],
        "at-end": [step("at-end", 1, NOW, "excluded")],
        stale: [step("stale", 1, NOW - 2 * DAY, "old")],
      },
    ));

    const search = reader.search({ keyword: "", fromInclusive: NOW - DAY, toExclusive: NOW });

    await expect(search).resolves.toMatchObject({ query: { keyword: "" } });
    const result = await search;
    expect(result.matches.map((match) => match.runId)).toEqual(["at-start"]);
  });

  it("@scenario S-R237511TR-02-filter \u540c\u65f6\u6309 engineer \u548c\u6700\u8fd1\u4e8c\u5341\u56db\u5c0f\u65f6\u6536\u7a84\u5de5\u4f5c", async () => {
    const reader = createWorkRecordReader(source(
      [
        run("engineer-recent", "engineer", { kind: "running", refreshAfterMs: 5_000 }),
        run("engineer-old", "engineer", { kind: "stopped", outcome: "completed", stoppedAt: NOW - 3 * DAY }),
        run("prototype-recent", "prototype", { kind: "running", refreshAfterMs: 5_000 }),
      ],
      {
        "engineer-recent": [step("engineer-recent", 1, NOW - 60_000, "recent")],
        "engineer-old": [step("engineer-old", 1, NOW - 3 * DAY, "old")],
        "prototype-recent": [step("prototype-recent", 1, NOW - 30_000, "other role")],
      },
    ));

    const outcome = await reader.search({
      keyword: "",
      role: "engineer",
      fromInclusive: NOW - DAY,
      toExclusive: NOW,
    }).then(
      (value) => ({ kind: "result" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );

    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    expect(outcome.value.query.role).toBe("engineer");
    expect(outcome.value.matches.map((match) => match.runId)).toEqual(["engineer-recent"]);
  });

  it("@scenario S-R237511TR-02-filter \u5de5\u4f5c\u5f00\u59cb\u8f83\u65e9\u4f46\u65f6\u6bb5\u5185\u6709\u65b0\u8bb0\u5f55\u65f6\u4fdd\u7559\u4e14\u65f6\u6bb5\u5185\u65e0\u8bb0\u5f55\u65f6\u6392\u9664", async () => {
    const activeAcrossBoundary = run("active-across-boundary", "engineer", { kind: "running", refreshAfterMs: 5_000 });
    const inactiveInRange = run("inactive-in-range", "engineer", {
      kind: "stopped",
      outcome: "completed",
      stoppedAt: NOW - 2 * DAY,
    });
    const reader = createWorkRecordReader(source(
      [inactiveInRange, activeAcrossBoundary],
      {
        "active-across-boundary": [
          step("active-across-boundary", 1, NOW - 3 * DAY, "started earlier"),
          step("active-across-boundary", 2, NOW - 1_000, "new activity"),
        ],
        "inactive-in-range": [step("inactive-in-range", 1, NOW - 2 * DAY, "no recent activity")],
      },
    ));

    const search = reader.search({
      keyword: "",
      role: "engineer",
      fromInclusive: NOW - DAY,
      toExclusive: NOW,
    });

    await expect(search).resolves.toMatchObject({ query: { keyword: "", role: "engineer" } });
    const result = await search;
    expect(result.matches.map((match) => [match.runId, match.occurredAt])).toEqual([
      ["active-across-boundary", NOW - 1_000],
    ]);
  });

  it("@scenario S-R237511TR-02-errors \u5217\u8868\u72b6\u6001\u6765\u81ea\u5de5\u4f5c\u7684\u5f53\u524d\u7ed3\u679c\u800c\u4e0d\u662f\u8bb0\u5f55\u6b63\u6587", async () => {
    const completedAt = NOW - 20_000;
    const erroredAt = NOW - 10_000;
    const reader = createWorkRecordReader(source(
      [
        run("running", "engineer", { kind: "running", refreshAfterMs: 5_000 }),
        run("completed", "prototype", { kind: "stopped", outcome: "completed", stoppedAt: completedAt }),
        run("errored", "prototype", { kind: "stopped", outcome: "error", stoppedAt: erroredAt }),
      ],
      {
        running: [step("running", 1, NOW - 30_000, "working")],
        completed: [step("completed", 1, NOW - 20_000, "error wording in a successful record")],
        errored: [step("errored", 1, NOW - 10_000, "ordinary final message")],
      },
    ));

    const search = reader.search({ keyword: "", fromInclusive: NOW - DAY, toExclusive: NOW });

    await expect(search).resolves.toMatchObject({ query: { keyword: "" } });
    const result = await search;
    expect(Object.fromEntries(result.matches.map((match) => [match.runId, match.status]))).toEqual({
      running: { kind: "running" },
      completed: { kind: "stopped", outcome: "completed", stoppedAt: completedAt },
      errored: { kind: "stopped", outcome: "error", stoppedAt: erroredAt },
    });
  });

  it("@scenario S-R237511TR-02-errors \u6b63\u5e38\u7ed3\u675f\u7684\u5de5\u4f5c\u5373\u4f7f\u6b63\u6587\u51fa\u73b0 error \u4e5f\u4e0d\u5f97\u53d8\u6210\u51fa\u9519\u72b6\u6001", async () => {
    const stoppedAt = NOW - 5_000;
    const completed = run("completed", "engineer", { kind: "stopped", outcome: "completed", stoppedAt });
    const reader = createWorkRecordReader(source(
      [completed],
      { completed: [step("completed", 1, NOW - 10_000, "checked prior error and completed normally")] },
    ));

    const result = await reader.search({ keyword: "error", fromInclusive: NOW - DAY, toExclusive: NOW });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.status).toEqual({ kind: "stopped", outcome: "completed", stoppedAt });
  });
});

describe("live work record continuation", () => {
  it("@scenario S-R237511TR-02-live \u589e\u91cf\u5185\u5bb9\u8ffd\u52a0\u5230\u5df2\u663e\u793a\u8bb0\u5f55\u5e76\u5728\u7ed3\u675f\u65f6\u7ed9\u51fa\u5b8c\u6210\u72b6\u6001\u548c\u7ed3\u675f\u65f6\u95f4", () => {
    const current = runningDetail("run-live", 2);
    const stoppedAt = NOW;
    const continuation: WorkRecordDetailResult = {
      incremental: true,
      record: {
        ...runningDetail("run-live", 3),
        status: { kind: "stopped", outcome: "completed", stoppedAt, durationMs: 120_000 },
        steps: [runningDetail("run-live", 3).steps[2]!],
      },
    };
    const merge = workRecordReader.mergeWorkRecordContinuation;

    expect(merge).toBeTypeOf("function");
    if (typeof merge !== "function") return;
    const result = merge(current, 2, continuation);

    expect(result.kind).toBe("applied");
    expect(result.record.steps.map((candidate) => candidate.sequence)).toEqual([1, 2, 3]);
    expect(result.record.throughSequence).toBe(3);
    expect(result.record.status).toEqual({
      kind: "stopped",
      outcome: "completed",
      stoppedAt,
      durationMs: 120_000,
    });
  });

  it("@scenario S-R237511TR-02-live \u5207\u6362\u9009\u62e9\u540e\u7684\u65e7\u54cd\u5e94\u548c\u91cd\u590d\u6e38\u6807\u54cd\u5e94\u4e0d\u5f97\u6539\u5199\u5f53\u524d\u5b8c\u6574\u8bb0\u5f55", () => {
    const current = runningDetail("run-current", 2);
    const staleRun: WorkRecordDetailResult = {
      incremental: true,
      record: { ...runningDetail("run-previous", 3), steps: [runningDetail("run-previous", 3).steps[2]!] },
    };
    const duplicateCursor: WorkRecordDetailResult = {
      incremental: true,
      record: { ...runningDetail("run-current", 2), steps: [] },
    };
    const merge = workRecordReader.mergeWorkRecordContinuation;

    expect(merge).toBeTypeOf("function");
    if (typeof merge !== "function") return;
    expect(merge(current, 2, staleRun)).toEqual({ kind: "stale", record: current });
    expect(merge(current, 1, duplicateCursor)).toEqual({ kind: "stale", record: current });
  });
});
