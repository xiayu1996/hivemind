import { describe, expect, it } from "vitest";
import {
  createWorkRecordReader,
  type WorkRecordSource,
  type WorkRecordSourceRun,
  type WorkRecordSourceStep,
} from "./work-record-reader.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;
const FAILURE_TEXT = "Notion \u4fdd\u5b58\u5931\u8d25";
const JWT_PREFIX = ["e", "y", "J"].join("");
const SECRET_KEY_PREFIX = ["s", "k", "-"].join("");

function stoppedRun(
  runId: string,
  role: string,
  name: string,
  startedAt: number,
  requirementId: string,
): WorkRecordSourceRun {
  return {
    runId,
    role,
    name,
    requirement: { id: requirementId, title: `Requirement ${requirementId}` },
    startedAt,
    status: { kind: "stopped", outcome: "error", stoppedAt: startedAt + 60_000 },
  };
}

function displayStep(
  runId: string,
  sequence: number,
  occurredAt: number,
  text: string,
  kind: WorkRecordSourceStep["kind"] = "action",
): WorkRecordSourceStep {
  return { runId, sequence, occurredAt, kind, text, visibility: "display" };
}

function source(
  runs: readonly WorkRecordSourceRun[],
  steps: Readonly<Record<string, readonly WorkRecordSourceStep[]>>,
): WorkRecordSource {
  return {
    loadRuns: async () => runs,
    loadSteps: async (runId, afterSequence) => (steps[runId] ?? [])
      .filter((step) => afterSequence === undefined || step.sequence > afterSequence),
  };
}

describe("work record search", () => {
  it("@scenario S-R237511TR-01-search returns every matching run newest first with its identity and literal hit", async () => {
    const older = stoppedRun("run-prototype", "prototype", "Prototype exit correction", NOW - 3_600_000, "R-101");
    const newer = stoppedRun("run-engineer", "engineer", "Persist todo result", NOW - 1_800_000, "R-202");
    const unrelated = stoppedRun("run-accountant", "accountant", "Daily cost summary", NOW - 900_000, "R-303");
    const reader = createWorkRecordReader(source(
      [older, unrelated, newer],
      {
        [older.runId]: [
          displayStep(older.runId, 1, older.startedAt + 20_000, `${FAILURE_TEXT} while publishing the prototype`),
          displayStep(older.runId, 2, older.startedAt + 20_000, `${FAILURE_TEXT} while publishing the prototype`),
        ],
        [newer.runId]: [displayStep(newer.runId, 1, newer.startedAt + 30_000, `Todo result remained pending after ${FAILURE_TEXT}`)],
        [unrelated.runId]: [displayStep(unrelated.runId, 1, unrelated.startedAt + 10_000, "Daily cost summary completed")],
      },
    ), { now: () => NOW });

    const result = await reader.search({
      keyword: FAILURE_TEXT,
      fromInclusive: NOW - DAY,
      toExclusive: NOW,
    });

    expect(result).toEqual({
      query: { keyword: FAILURE_TEXT, fromInclusive: NOW - DAY, toExclusive: NOW },
      matches: [
        {
          runId: "run-engineer",
          role: "engineer",
          name: "Persist todo result",
          occurredAt: newer.startedAt + 30_000,
          requirement: { id: "R-202", title: "Requirement R-202" },
          hit: [
            { value: "Todo result remained pending after ", matched: false, redaction: "applied" },
            { value: FAILURE_TEXT, matched: true, redaction: "applied" },
          ],
        },
        {
          runId: "run-prototype",
          role: "prototype",
          name: "Prototype exit correction",
          occurredAt: older.startedAt + 20_000,
          requirement: { id: "R-101", title: "Requirement R-101" },
          hit: [
            { value: FAILURE_TEXT, matched: true, redaction: "applied" },
            { value: " while publishing the prototype", matched: false, redaction: "applied" },
          ],
        },
      ],
      snapshotAt: NOW,
    });
  });

  it("@scenario S-R237511TR-01-search treats the start as inclusive, the end as exclusive, and applies the selected role", async () => {
    const atStart = stoppedRun("run-at-start", "prototype", "At start", NOW - DAY, "R-101");
    const atEnd = stoppedRun("run-at-end", "prototype", "At end", NOW, "R-102");
    const otherRole = stoppedRun("run-other-role", "engineer", "Other role", NOW - 1_000, "R-103");
    const text = FAILURE_TEXT;
    const reader = createWorkRecordReader(source(
      [atEnd, otherRole, atStart],
      {
        [atStart.runId]: [displayStep(atStart.runId, 1, atStart.startedAt, text)],
        [atEnd.runId]: [displayStep(atEnd.runId, 1, atEnd.startedAt, text)],
        [otherRole.runId]: [displayStep(otherRole.runId, 1, otherRole.startedAt, text)],
      },
    ), { now: () => NOW });

    const result = await reader.search({
      keyword: `  ${text}  `,
      role: "prototype",
      fromInclusive: NOW - DAY,
      toExclusive: NOW,
    });

    expect(result.query.keyword).toBe(text);
    expect(result.matches.map((match) => match.runId)).toEqual(["run-at-start"]);
  });

  it("@scenario S-R237511TR-01-search does not match another case, an internal payload, or a redacted token", async () => {
    const jwt = `${JWT_PREFIX}${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    const run = stoppedRun("run-sensitive", "prototype", "Sensitive request", NOW - 1_000, "R-101");
    const reader = createWorkRecordReader(source(
      [run],
      {
        [run.runId]: [
          displayStep(run.runId, 1, run.startedAt, `Authorization used Bearer ${jwt}`),
          { ...displayStep(run.runId, 2, run.startedAt + 1, `${FAILURE_TEXT} in provider payload`), visibility: "internal_transport" },
        ],
      },
    ), { now: () => NOW });
    const range = { fromInclusive: NOW - DAY, toExclusive: NOW };

    await expect(reader.search({ keyword: FAILURE_TEXT.toLowerCase(), ...range }))
      .resolves.toMatchObject({ matches: [] });
    await expect(reader.search({ keyword: "provider payload", ...range }))
      .resolves.toMatchObject({ matches: [] });
    await expect(reader.search({ keyword: jwt, ...range }))
      .resolves.toMatchObject({ matches: [] });
  });
});

describe("complete work record", () => {
  it("@scenario S-R237511TR-01-full returns the selected run from start to error stop in sequence with secrets redacted", async () => {
    const startedAt = Date.parse("2026-09-20T10:38:12.000Z");
    const stoppedAt = Date.parse("2026-09-20T10:43:06.000Z");
    const selected: WorkRecordSourceRun = {
      runId: "run-selected",
      role: "prototype",
      name: "Prototype exit correction",
      requirement: { id: "R-101", title: "Prototype workflow" },
      startedAt,
      status: { kind: "stopped", outcome: "error", stoppedAt },
    };
    const other = stoppedRun("run-other", "accountant", "Daily cost summary", stoppedAt + 60_000, "R-202");
    const token = `${SECRET_KEY_PREFIX}${"x".repeat(24)}`;
    const selectedSteps = [
      displayStep(selected.runId, 10, stoppedAt, "Work stopped after the save failure", "stop"),
      displayStep(selected.runId, 7, Date.parse("2026-09-20T10:42:03.000Z"), `${FAILURE_TEXT}: connection closed before confirmation`, "error"),
      displayStep(selected.runId, 1, startedAt, "Work started", "start"),
      displayStep(selected.runId, 2, Date.parse("2026-09-20T10:38:30.000Z"), "Opened the prototype review"),
      displayStep(selected.runId, 3, Date.parse("2026-09-20T10:39:00.000Z"), "Read the exit findings"),
      displayStep(selected.runId, 4, Date.parse("2026-09-20T10:39:30.000Z"), "Adjusted the visible wording"),
      displayStep(selected.runId, 5, Date.parse("2026-09-20T10:40:00.000Z"), "Checked the prototype state"),
      displayStep(selected.runId, 6, Date.parse("2026-09-20T10:41:30.000Z"), `Sent the save request with ${token}`),
      displayStep(selected.runId, 8, Date.parse("2026-09-20T10:42:20.000Z"), "Kept the failed item pending"),
      displayStep(selected.runId, 9, Date.parse("2026-09-20T10:42:50.000Z"), "Recorded the failure reason"),
      { ...displayStep(selected.runId, 0, startedAt - 1, "raw provider request body"), visibility: "internal_transport" as const },
      displayStep(other.runId, 1, other.startedAt, "Daily cost summary completed"),
    ];
    const reader = createWorkRecordReader(source(
      [other, selected],
      { [selected.runId]: selectedSteps, [other.runId]: [displayStep(other.runId, 1, other.startedAt, "Daily cost summary completed")] },
    ));

    const result = await reader.read({ runId: selected.runId });

    expect(result.incremental).toBe(false);
    expect(result.record).toMatchObject({
      runId: "run-selected",
      role: "prototype",
      name: "Prototype exit correction",
      requirement: { id: "R-101", title: "Prototype workflow" },
      startedAt,
      status: { kind: "stopped", outcome: "error", stoppedAt, durationMs: 294_000 },
      throughSequence: 10,
    });
    expect(result.record.steps.map((step) => step.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.record.steps[6]).toMatchObject({
      runId: selected.runId,
      kind: "error",
      text: { value: `${FAILURE_TEXT}: connection closed before confirmation`, redaction: "applied" },
    });
    expect(result.record.steps[7]?.text.value).toBe("Kept the failed item pending");
    const visibleText = result.record.steps.map((step) => step.text.value).join("\n");
    expect(visibleText).not.toContain(token);
    expect(visibleText).not.toMatch(/raw provider request body|Daily cost summary completed/);
    expect(result.record.steps[5]?.text.value).toBe("Sent the save request with [REDACTED]");
  });

  it("@scenario S-R237511TR-01-full ignores over-returned steps from another run", async () => {
    const selected = stoppedRun("run-selected", "prototype", "Prototype exit correction", NOW - 60_000, "R-101");
    const reader = createWorkRecordReader(source(
      [selected],
      {
        [selected.runId]: [
          displayStep("run-other", 1, selected.startedAt, "Daily cost summary completed"),
          displayStep(selected.runId, 1, selected.startedAt, "Work started", "start"),
          displayStep(selected.runId, 2, selected.startedAt + 60_000, "Work stopped", "stop"),
        ],
      },
    ));

    const result = await reader.read({ runId: selected.runId });

    expect(result.record.steps).toHaveLength(2);
    expect(result.record.steps.every((step) => step.runId === selected.runId)).toBe(true);
  });

  it("@scenario S-R237511TR-01-full returns only append-only steps when an active record is refreshed", async () => {
    const running: WorkRecordSourceRun = {
      runId: "run-active",
      role: "engineer",
      name: "Persist todo result",
      requirement: { id: "R-202", title: "Todo workflow" },
      startedAt: NOW - 60_000,
      status: { kind: "running", refreshAfterMs: 5_000 },
    };
    const reader = createWorkRecordReader(source(
      [running],
      {
        [running.runId]: [
          displayStep(running.runId, 1, running.startedAt, "Work started", "start"),
          displayStep(running.runId, 2, running.startedAt + 10_000, "Opened the todo"),
          displayStep(running.runId, 3, running.startedAt + 20_000, "Prepared the update"),
          displayStep(running.runId, 4, running.startedAt + 30_000, "Sent the update"),
          displayStep(running.runId, 5, running.startedAt + 40_000, "Waiting for confirmation"),
        ],
      },
    ));

    const result = await reader.read({ runId: running.runId, afterSequence: 3 });

    expect(result.incremental).toBe(true);
    expect(result.record.status).toEqual({ kind: "running", refreshAfterMs: 5_000 });
    expect(result.record.steps.map((step) => step.sequence)).toEqual([4, 5]);
    expect(result.record.throughSequence).toBe(5);
  });

  it("@scenario S-R237511TR-01-full reports a stable non-retryable not_found failure for an unknown run", async () => {
    const reader = createWorkRecordReader(source([], {}));

    await expect(reader.read({ runId: "run-missing" })).rejects.toMatchObject({
      code: "not_found",
      retryable: false,
    });
  });
});
