import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import {
  assessProgress,
  readProgressSnapshot,
  renderProgressReport,
  type ProgressSnapshot,
} from "./progress-health.js";

const NOW = 10_000_000;
const MINUTE = 60_000;

function snapshot(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    workingCards: [],
    stoppedCards: [],
    waitingEpics: [],
    unmergeableEpics: [],
    oldestPendingOutboxAt: null,
    registeredScenarios: 1,
    regressionRunsEver: 1,
    lastPassingRegressionAt: NOW - MINUTE,
    ...overrides,
  };
}

describe("assessProgress", () => {
  it("says nothing is stuck when work is moving", () => {
    const report = assessProgress(snapshot({
      workingCards: [{ cardId: "S-1", state: "CODE", updatedAt: NOW - MINUTE, running: true }],
    }), NOW);

    expect(report.healthy).toBe(true);
    expect(renderProgressReport(report)).toContain("Everything is moving");
  });

  it("names a card that has stopped changing while the host keeps running", () => {
    // The failure mode a pid check cannot see: the process is up, the cycle is
    // ticking, and one card has not moved for an hour.
    const report = assessProgress(snapshot({
      workingCards: [{ cardId: "S-E2RESULTS-01", state: "VERIFY", updatedAt: NOW - 60 * MINUTE, running: true }],
    }), NOW);

    expect(report.healthy).toBe(false);
    expect(report.findings[0]?.summary).toContain("S-E2RESULTS-01");
    expect(report.findings[0]?.summary).toContain("60 minutes");
  });

  it("does not call a card stuck when it is queued behind the host's concurrency limit", () => {
    // A host runs a fixed number of Stories at once. The ones without a slot
    // sit in CODE for as long as the running ones take, and reported as idle
    // time that is indistinguishable from the stall this probe is for.
    const report = assessProgress(snapshot({
      workingCards: [
        { cardId: "S-RUNNING", state: "CODE", updatedAt: NOW - MINUTE, running: true },
        { cardId: "S-QUEUED", state: "CODE", updatedAt: NOW - 700 * MINUTE, running: false },
      ],
    }), NOW);

    expect(report.healthy).toBe(true);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ severity: "queued" });
    expect(renderProgressReport(report)).toContain("Queued behind the host's concurrency limit:");
  });

  it("calls a card stuck when it is not running and nothing else is either", () => {
    // Nothing holds a slot and nothing is picking the card up: the dispatch
    // failure the queue exception must not hide.
    const report = assessProgress(snapshot({
      workingCards: [{ cardId: "S-ALONE", state: "CODE", updatedAt: NOW - 700 * MINUTE, running: false }],
    }), NOW);

    expect(report.healthy).toBe(false);
    expect(report.findings[0]?.summary).toContain("nothing at all is running");
  });

  it("reports a card waiting for a person without calling the system unhealthy", () => {
    // A designed stop is not a fault, but a stop nobody was told about is
    // indistinguishable from a stall.
    const report = assessProgress(snapshot({
      stoppedCards: [{ cardId: "S-1", stopReason: "blocking_question", updatedAt: NOW - 120 * MINUTE }],
    }), NOW);

    expect(report.healthy).toBe(true);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ severity: "waiting" });
    expect(report.findings[0]?.summary).toContain("blocking_question");
  });

  it("leaves a board with nothing registered alone, since it owes no evidence", () => {
    // The state right after a requirement is abandoned, and the state of a
    // fresh install. Neither is stuck.
    const report = assessProgress(snapshot({
      registeredScenarios: 0,
      regressionRunsEver: 0,
      lastPassingRegressionAt: null,
    }), NOW);

    expect(report.healthy).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it("calls a registry that has never been swept a stall, not a clean board", () => {
    const report = assessProgress(snapshot({ regressionRunsEver: 0, lastPassingRegressionAt: null }), NOW);

    expect(report.healthy).toBe(false);
    expect(report.findings[0]?.summary).toContain("has ever been recorded");
  });

  it("separates sweeps that run and never pass from sweeps that never run", () => {
    const report = assessProgress(snapshot({ regressionRunsEver: 20, lastPassingRegressionAt: null }), NOW);

    expect(report.findings[0]?.summary).toContain("none has ever passed");
  });

  it("reads a Notion backlog as the board no longer showing the truth", () => {
    const report = assessProgress(snapshot({ oldestPendingOutboxAt: NOW - 40 * MINUTE }), NOW);

    expect(report.healthy).toBe(false);
    expect(report.findings[0]?.summary).toContain("40 minutes");
  });

  it("calls a review request that cannot take main a stall, not a wait", () => {
    // Nobody can act on it: the person cannot merge, and the last attempt to
    // bring main into the branch failed.
    const report = assessProgress(snapshot({
      unmergeableEpics: [{ epicId: "E1ACTION", reason: "Merge conflict in src/orchestrator/story-execution-store.ts", at: NOW }],
    }), NOW);

    expect(report.healthy).toBe(false);
    expect(report.findings[0]?.summary).toContain("story-execution-store.ts");
  });

  it("names the Epic held at its own gate and how much evidence it lacks", () => {
    const report = assessProgress(snapshot({
      waitingEpics: [{ epicId: "E3OVERVIEW", unprovenScenarios: 14 }],
    }), NOW);

    expect(report.findings[0]?.summary).toContain("E3OVERVIEW");
    expect(report.findings[0]?.summary).toContain("14");
  });
});

describe("readProgressSnapshot", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
  });

  afterEach(() => client.close());

  it("reads an Epic whose Stories are all delivered and whose scenarios have never passed", async () => {
    await client.batch([
      "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('E1', 'p1', 'Board', 'EXECUTING', 1, 1)",
      "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-E1-01', 'E1', 's1', 'One', 'r', 'DELIVERED', 1, 1)",
      "INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at) VALUES ('S-E1-01-a', 'S-E1-01', 'E1', 'epic', 1, 1)",
      "INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at) VALUES ('S-E1-01-b', 'S-E1-01', 'E1', 'epic', 1, 1)",
    ], "write");

    await expect(readProgressSnapshot(client)).resolves.toMatchObject({
      waitingEpics: [{ epicId: "E1", unprovenScenarios: 2 }],
      registeredScenarios: 2,
      regressionRunsEver: 0,
      lastPassingRegressionAt: null,
    });
  });

  it("dates a card by what it last did, not by when its row was last written", async () => {
    await client.batch([
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-E1-01', 's1', 'One', 'r', 'CODE', 1, 9000)",
      "INSERT INTO event_log (run_id, seq, card_id, type, ts, data) VALUES ('r1', 1, 'S-E1-01', 'phase.enter', 1000, '{}')",
    ], "write");

    const read = await readProgressSnapshot(client);
    expect(read.workingCards).toEqual([{ cardId: "S-E1-01", state: "CODE", updatedAt: 1000, running: false }]);
  });

  it("falls back to the row for a card that has not done anything yet", async () => {
    await client.execute(
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-E1-01', 's1', 'One', 'r', 'CODE', 1, 9000)",
    );

    const read = await readProgressSnapshot(client);
    expect(read.workingCards).toEqual([{ cardId: "S-E1-01", state: "CODE", updatedAt: 9000, running: false }]);
  });

  it("stops reporting an Epic once its scenarios have passed somewhere", async () => {
    await client.batch([
      "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('E1', 'p1', 'Board', 'EXECUTING', 1, 1)",
      "INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-E1-01', 'E1', 's1', 'One', 'r', 'DELIVERED', 1, 1)",
      "INSERT INTO scenario_registry (scenario_id, story_id, epic_id, pool, created_at, updated_at) VALUES ('S-E1-01-a', 'S-E1-01', 'E1', 'epic', 1, 1)",
      "INSERT INTO regression_runs (scenario_id, pool, revision, outcome, ts) VALUES ('S-E1-01-a', 'epic', 'rev', 'passed', 5)",
    ], "write");

    await expect(readProgressSnapshot(client)).resolves.toMatchObject({
      waitingEpics: [],
      lastPassingRegressionAt: 5,
    });
  });

  it("separates cards still working from cards that stopped for a person", async () => {
    await client.batch([
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('S-1', 's1', 'One', 'r', 'CODE', 1, 7)",
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, stop_reason, created_at, updated_at) VALUES ('S-2', 's2', 'Two', 'r', 'NEEDS_INPUT', 'blocking_question', 1, 8)",
    ], "write");

    const read = await readProgressSnapshot(client);
    expect(read.workingCards).toMatchObject([{ cardId: "S-1", state: "CODE" }]);
    expect(read.stoppedCards).toMatchObject([{ cardId: "S-2", stopReason: "blocking_question" }]);
  });
});
