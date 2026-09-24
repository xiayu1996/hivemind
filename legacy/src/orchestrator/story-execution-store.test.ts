import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { parseDoD } from "../pipeline/dod.js";
import { assemblePhasePrompt } from "../pipeline/phase-input.js";
import { StoryExecutionStore } from "./story-execution-store.js";

/**
 * Walks the front of the pipeline. SHAPE and SPECIFY are not what these tests
 * are about, so they get their own run ids and the caller's names the phase it
 * actually came for.
 */
async function enterDesign(store: StoryExecutionStore, cardId: string, runId: string): Promise<void> {
  await store.transition(cardId, "QUEUED", "SHAPE", "system", `${runId}-shape`);
  await store.transition(cardId, "SHAPE", "DESIGN", "system", runId);
}

async function designToCode(store: StoryExecutionStore, cardId: string, runId: string): Promise<void> {
  await store.transition(cardId, "DESIGN", "SPECIFY", "system", `${runId}-specify`);
  await store.transition(cardId, "SPECIFY", "CODE", "system", runId);
}

describe("StoryExecutionStore", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;
  let time: number;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    time = 1_000;
    store = new StoryExecutionStore(client, () => time++);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Persist phase context",
      requirement: "A later phase can rebuild all prior inputs from the central database.",
      repo: "D:/repo",
      branch: "story/epic1-01",
    });
  });

  afterEach(() => {
    client.close();
  });

  it("moves a Story with a compare-and-set transition and records the event atomically", async () => {
    await enterDesign(store, "S-EPIC1-01", "run-design");
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      state: "DESIGN",
      phase: "DESIGN",
      requirement: "A later phase can rebuild all prior inputs from the central database.",
    });
    await expect(
      store.transition("S-EPIC1-01", "SHAPE", "DESIGN", "system", "lost-race"),
    ).rejects.toThrow(/lost a race/);
    const events = await client.execute(
      "SELECT type, data FROM event_log WHERE run_id = 'run-design' ORDER BY seq",
    );
    expect(events.rows).toMatchObject([{
      type: "story.transition",
      data: JSON.stringify({ from: "SHAPE", to: "DESIGN", actor: "system" }),
    }]);
  });

  it("persists a completed phase and rebuilds a byte-identical later prompt without local files", async () => {
    await enterDesign(store, "S-EPIC1-01", "run-design");
    const designInput = await store.buildPhaseInput("S-EPIC1-01", "DESIGN", 1);
    const designPrompt = assemblePhasePrompt(designInput);
    await store.beginPhase({
      runId: "run-design",
      cardId: "S-EPIC1-01",
      phase: "DESIGN",
      round: 1,
      prompt: designPrompt,
    });
    await store.completePhase({
      runId: "run-design",
      sessionId: "session-design",
      artifacts: [
        { kind: "design-summary", body: "Use the central artifact ledger." },
        { kind: "dod", body: "story_id: S-EPIC1-01" },
      ],
    });
    await designToCode(store, "S-EPIC1-01", "run-code");

    const first = assemblePhasePrompt(await store.buildPhaseInput("S-EPIC1-01", "CODE", 1));
    const second = assemblePhasePrompt(await store.buildPhaseInput("S-EPIC1-01", "CODE", 1));
    expect(second).toBe(first);
    expect(first).toContain("DESIGN / design-summary");
    expect(first).toContain("Use the central artifact ledger.");

    // Two CODE rounds and two verdicts later, the next prompt carries the
    // newest account of each kind only, plus why the last verdict refused.
    await store.beginPhase({ runId: "run-code-1", cardId: "S-EPIC1-01", phase: "CODE", round: 1, prompt: "code" });
    await store.completePhase({ runId: "run-code-1", sessionId: "s-code-1", artifacts: [{ kind: "implementation", body: "First attempt." }] });
    await store.transition("S-EPIC1-01", "CODE", "VERIFY", "system", "run-verify-1");
    await store.beginPhase({ runId: "run-verify-1", cardId: "S-EPIC1-01", phase: "VERIFY", round: 1, prompt: "verify" });
    await store.completePhase({ runId: "run-verify-1", sessionId: "s-verify-1", artifacts: [{ kind: "verification", body: JSON.stringify({ reasons: [{ scenarioId: "S-EPIC1-01-a", reason: "old reason" }] }) }] });
    await store.transition("S-EPIC1-01", "VERIFY", "CODE", "system", "run-verify-1");
    await store.beginPhase({ runId: "run-code-2", cardId: "S-EPIC1-01", phase: "CODE", round: 2, prompt: "code" });
    await store.completePhase({ runId: "run-code-2", sessionId: "s-code-2", artifacts: [{ kind: "implementation", body: "Second attempt." }] });
    await store.transition("S-EPIC1-01", "CODE", "VERIFY", "system", "run-verify-2");
    await store.beginPhase({ runId: "run-verify-2", cardId: "S-EPIC1-01", phase: "VERIFY", round: 2, prompt: "verify" });
    await store.completePhase({ runId: "run-verify-2", sessionId: "s-verify-2", artifacts: [{ kind: "verification", body: JSON.stringify({
      reasons: [{ scenarioId: "S-EPIC1-01-a", reason: "expected 2, received 1" }],
      uiReview: { acceptance: [{ id: "S-EPIC1-01-a", status: "failed", reason: "the total is missing", cites: "the total is shown" }] },
    }) }] });
    const third = await store.buildPhaseInput("S-EPIC1-01", "CODE", 3);
    expect(third.artifacts.filter((item) => item.kind === "implementation").map((item) => item.body)).toEqual(["Second attempt."]);
    expect(third.artifacts.filter((item) => item.kind === "verification")).toHaveLength(1);
    expect(third.scenarioFailures).toEqual([
      { scenarioId: "S-EPIC1-01-a", reason: "expected 2, received 1", source: "tests" },
      { scenarioId: "S-EPIC1-01-a", reason: "the total is missing (the DoD says: the total is shown)", source: "screen" },
    ]);

    const run = await client.execute(
      "SELECT status, session_id, length(prompt_sha256) AS hash_length FROM phase_runs WHERE run_id = 'run-design'",
    );
    expect(run.rows[0]).toMatchObject({ status: "completed", session_id: "session-design", hash_length: 64 });
  });

  it("rolls back artifacts when completing the same run twice", async () => {
    await enterDesign(store, "S-EPIC1-01", "run-design");
    await store.beginPhase({
      runId: "run-design",
      cardId: "S-EPIC1-01",
      phase: "DESIGN",
      round: 1,
      prompt: "prompt",
    });
    await store.completePhase({
      runId: "run-design",
      sessionId: "session-design",
      artifacts: [{ kind: "design-summary", body: "first" }],
    });
    await expect(store.completePhase({
      runId: "run-design",
      sessionId: "other-session",
      artifacts: [{ kind: "late", body: "must not land" }],
    })).rejects.toThrow(/already completed/);
    const artifacts = await client.execute("SELECT kind FROM phase_artifacts ORDER BY kind");
    expect(artifacts.rows).toMatchObject([{ kind: "design-summary" }]);
  });
});

describe("StoryExecutionStore merge recovery", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;
  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-M2-05-conflict", notionPageId: "page-conflict", title: "Conflict", requirement: "Resolve an integration conflict." });
    await enterDesign(store, "S-M2-05-conflict", "design");
    await designToCode(store, "S-M2-05-conflict", "code");
    await store.transition("S-M2-05-conflict", "CODE", "VERIFY", "system", "verify");
    await store.transition("S-M2-05-conflict", "VERIFY", "MERGE", "system", "merge");
  });
  afterEach(() => client.close());

  it("S-M2-05-conflict returns an unresolved rebase conflict to CODE and records it without delivering", async () => {
    await store.recordMergeConflict("S-M2-05-conflict", "merge-run", "CONFLICT (content): Merge conflict in src/vcs/merge-flow.ts", ["src/vcs/merge-flow.ts"]);
    await expect(store.getStory("S-M2-05-conflict")).resolves.toMatchObject({ state: "CODE", phase: "CODE", mrUrl: null });
    const events = (await client.execute("SELECT type, data FROM event_log WHERE run_id = 'merge-run' ORDER BY id")).rows;
    // A conflict is the Story's own to resolve, so the round is spent; the
    // transition beside it is what makes the bounce bounded rather than a
    // silent UPDATE the budget never saw.
    expect(events.map((row) => row.type)).toEqual(["merge.conflict", "story.transition"]);
    expect(JSON.parse(String(events[0]?.data))).toEqual({
      reason: "CONFLICT (content): Merge conflict in src/vcs/merge-flow.ts",
      conflictedFiles: ["src/vcs/merge-flow.ts"],
      spent: true,
    });
  });
});

describe("StoryExecutionStore resume budget", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;
  let time: number;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    time = 1_000;
    store = new StoryExecutionStore(client, () => time++);
    await store.createStory({ id: "S-MQ-10-resume", notionPageId: "page-resume", title: "Resume", requirement: "A parked Story runs again." });
  });
  afterEach(() => client.close());

  it("counts a person's resume as the moment the round budget starts again", async () => {
    await enterDesign(store, "S-MQ-10-resume", "design");
    const beforeResume = await store.getStory("S-MQ-10-resume");
    expect(beforeResume.lastHumanActionAt ?? null).toBeNull();
    await store.transition("S-MQ-10-resume", "DESIGN", "SPECIFY", "human", "resume");
    const afterResume = await store.getStory("S-MQ-10-resume");
    expect(afterResume.lastHumanActionAt).toBeGreaterThan(0);
  });

  it("leaves the mark alone when the system moves the card", async () => {
    await store.transition("S-MQ-10-resume", "QUEUED", "SHAPE", "human", "human-start");
    const stamped = (await store.getStory("S-MQ-10-resume")).lastHumanActionAt;
    await store.transition("S-MQ-10-resume", "SHAPE", "DESIGN", "system", "code");
    await expect(store.getStory("S-MQ-10-resume")).resolves.toMatchObject({ lastHumanActionAt: stamped });
  });
});

describe("StoryExecutionStore Epic membership", () => {
  it("persists the Epic a Story was intaken under so delivery knows an Epic MR covers it", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await client.execute({
      sql: "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES (?, ?, ?, 'INTAKE', 1, 1)",
      args: ["EPIC1", "epic-page", "Parallel delivery"],
    });
    await store.createStory({
      id: "S-EPIC1-09",
      epicId: "EPIC1",
      notionPageId: "page-9",
      title: "Belongs to an Epic",
      requirement: "The Story is delivered through its Epic merge request.",
      branch: "story/epic1-09",
    });

    await expect(store.getStory("S-EPIC1-09")).resolves.toMatchObject({ epicId: "EPIC1" });
    client.close();
  });
});

describe("StoryExecutionStore phase slot guard", () => {
  it("keeps the previous attempt when the Story leaves the phase between the check and the write", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Race the phase slot",
      requirement: "A rejected phase start must not destroy the attempt it refused to supersede.",
      branch: "story/epic1-01",
    });
    await enterDesign(store, "S-EPIC1-01", "run-0");
    await client.execute({
      sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, failure, started_at, ended_at)
            VALUES ('run-old', 'S-EPIC1-01', 'DESIGN', 1, ?, 'failed', 'runner died', 1, 2)`,
      args: ["a".repeat(64)],
    });

    let raced = false;
    const racing = {
      execute: async (statement: unknown) => {
        const result = await client.execute(statement as never);
        const sql = String((statement as { sql?: string }).sql ?? "");
        if (!raced && sql.includes("FROM stories")) {
          raced = true;
          await client.execute("UPDATE stories SET state = 'CODE' WHERE id = 'S-EPIC1-01'");
        }
        return result;
      },
      batch: (statements: unknown, mode: unknown) => client.batch(statements as never, mode as never),
    } as unknown as typeof client;

    await expect(new StoryExecutionStore(racing, () => 2_000).beginPhase({
      runId: "run-new",
      cardId: "S-EPIC1-01",
      phase: "DESIGN",
      round: 1,
      prompt: "design again",
    })).rejects.toThrow(/not in that phase/);

    const rows = (await client.execute("SELECT run_id, status FROM phase_runs WHERE card_id = 'S-EPIC1-01'")).rows;
    expect(rows).toMatchObject([{ run_id: "run-old", status: "failed" }]);
    client.close();
  });
});

describe("StoryExecutionStore invalidation audit", () => {
  it("records why a completed phase result was thrown away", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Audit invalidation",
      requirement: "Discarding a completed phase result leaves a trace.",
      branch: "story/epic1-01",
    });
    await enterDesign(store, "S-EPIC1-01", "run-0");
    await store.beginPhase({ runId: "run-design", cardId: "S-EPIC1-01", phase: "DESIGN", round: 1, prompt: "design" });
    await store.completePhase({ runId: "run-design", sessionId: "session-design", artifacts: [{ kind: "design-summary", body: "A design" }] });

    await store.invalidateCompletedPhase("S-EPIC1-01", "DESIGN", 1, "the design names no interface boundary");

    const events = (await client.execute(
      "SELECT run_id, type, data FROM event_log WHERE type = 'phase.invalidated'",
    )).rows;
    expect(events).toMatchObject([{
      run_id: "run-design",
      data: JSON.stringify({ round: 1, reason: "the design names no interface boundary" }),
    }]);
    client.close();
  });
});

describe("StoryExecutionStore reshape", () => {
  it("unfreezes the DoD and discards reusable results when a person sends the Story back to SHAPE", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    const store = new StoryExecutionStore(client, () => time++);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Redesign",
      requirement: "A Story sent back to SHAPE is shaped again.",
      branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-0-shape");
    await store.beginPhase({ runId: "run-shape", cardId: "S-EPIC1-01", phase: "SHAPE", round: 1, prompt: "shape" });
    await store.completePhase({ runId: "run-shape", sessionId: "s-shape", artifacts: [{ kind: "dod", body: "story_id: S-EPIC1-01" }] });
    await client.execute("INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES ('S-EPIC1-01-a','S-EPIC1-01',1,'a','pending')");
    await store.transition("S-EPIC1-01", "SHAPE", "DESIGN", "system", "run-0");
    await designToCode(store, "S-EPIC1-01", "run-0");
    // Round 1 reached a verdict; round 2 is a CODE result nobody verified.
    await store.beginPhase({ runId: "run-code-1", cardId: "S-EPIC1-01", phase: "CODE", round: 1, prompt: "code" });
    await store.completePhase({ runId: "run-code-1", sessionId: "s-code-1", artifacts: [{ kind: "implementation", body: "x" }] });
    await store.transition("S-EPIC1-01", "CODE", "VERIFY", "system", "run-verify-1");
    await store.beginPhase({ runId: "run-verify-1", cardId: "S-EPIC1-01", phase: "VERIFY", round: 1, prompt: "verify" });
    await store.completePhase({ runId: "run-verify-1", sessionId: "s-verify-1", artifacts: [{ kind: "verification", body: "{}" }] });
    await store.recordVerification("run-verify-1", {
      cardId: "S-EPIC1-01", round: 1, codeSessionId: "s-code-1", verifySessionId: "s-verify-1",
      verdict: "rejected", failedScenarios: ["S-EPIC1-01-a"],
    });
    await store.transition("S-EPIC1-01", "VERIFY", "CODE", "system", "run-verify-1");
    await store.beginPhase({ runId: "run-code-2", cardId: "S-EPIC1-01", phase: "CODE", round: 2, prompt: "code" });
    await store.completePhase({ runId: "run-code-2", sessionId: "s-code-2", artifacts: [{ kind: "implementation", body: "y" }] });
    await store.stopForInput("S-EPIC1-01", "CODE", "retry_limit_exceeded", "run-stop");

    await store.transition("S-EPIC1-01", "NEEDS_INPUT", "SHAPE", "human", "run-human");

    expect(await store.getCompletedPhase("S-EPIC1-01", "SHAPE", 1)).toBeNull();
    expect(await store.getCompletedPhase("S-EPIC1-01", "CODE", 2)).toBeNull();
    expect(await store.getCompletedPhase("S-EPIC1-01", "CODE", 1)).not.toBeNull();
    expect(await store.findFrozenDefinitionOfDone("S-EPIC1-01")).toBeNull();
    const events = (await client.execute("SELECT type FROM event_log WHERE type IN ('story.redesign','phase.invalidated') ORDER BY type")).rows;
    expect(events.map((row) => row.type)).toEqual(["phase.invalidated", "phase.invalidated", "story.redesign"]);
    client.close();
  });
});

describe("StoryExecutionStore resume after a stop", () => {
  it("gives back the reentry budget when a person answers a Story that spent it", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    const store = new StoryExecutionStore(client, () => time++);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Resumed by a comment",
      requirement: "A person answering in Notion resumes the card.",
      branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    await store.transition("S-EPIC1-01", "SHAPE", "DESIGN", "system", "run-design");
    await store.transition("S-EPIC1-01", "DESIGN", "SPECIFY", "system", "run-specify");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await store.recordDispatchFailure({
        cardId: "S-EPIC1-01", state: "SPECIFY", errorClass: "UNKNOWN",
        message: "worker exited with code 1", attempt, budget: 3, runId: `reentry-${attempt}`,
      });
    }
    await store.stopForInput("S-EPIC1-01", "SPECIFY", "retry_limit_exceeded", "run-stop");

    await store.transition("S-EPIC1-01", "NEEDS_INPUT", "SPECIFY", "human", "notion-comment");

    // Without this the card is dispatched once, and the first failure parks it
    // again on a budget it has no way to earn back by answering.
    expect((await store.getStory("S-EPIC1-01")).phaseReentries).toBe(0);
  });

  it("grants the regression reopens back as well, so a resumed Story is not parked by the next sweep", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Reopened twice",
      requirement: "A Story that spent its reopens is resumed by a person.",
      branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    await store.countRegressionReopen("S-EPIC1-01");
    await store.countRegressionReopen("S-EPIC1-01");
    await store.stopForInput("S-EPIC1-01", "SHAPE", "retry_limit_exceeded", "run-stop");

    await store.transition("S-EPIC1-01", "NEEDS_INPUT", "SHAPE", "human", "notion-comment");

    expect((await store.getStory("S-EPIC1-01")).regressionReopens).toBe(0);
    client.close();
  });

  it("clears the crash count once the card moves on, and keeps it when it is sent back", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    const store = new StoryExecutionStore(client, () => time++);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Still counting",
      requirement: "Crashes inside one phase stay spent until the card moves on.",
      branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    await store.recordDispatchFailure({
      cardId: "S-EPIC1-01", state: "SHAPE", errorClass: "UNKNOWN",
      message: "worker exited with code 1", attempt: 1, budget: 3, runId: "reentry-1",
    });
    expect((await store.getStory("S-EPIC1-01")).phaseReentries).toBe(1);

    // Getting through SHAPE is the proof that the crash belonged to a phase
    // that is now over; carrying it into DESIGN is what stopped a card on
    // three unrelated failures spread across its whole life.
    await store.transition("S-EPIC1-01", "SHAPE", "DESIGN", "system", "run-design");
    expect((await store.getStory("S-EPIC1-01")).phaseReentries).toBe(0);

    await store.transition("S-EPIC1-01", "DESIGN", "SPECIFY", "system", "run-specify");
    await store.recordDispatchFailure({
      cardId: "S-EPIC1-01", state: "SPECIFY", errorClass: "UNKNOWN",
      message: "worker exited with code 1", attempt: 1, budget: 3, runId: "reentry-2",
    });
    // Backwards is not progress: a card bouncing between two phases is exactly
    // what the counter is for.
    await store.transition("S-EPIC1-01", "SPECIFY", "SHAPE", "system", "run-reshape");
    expect((await store.getStory("S-EPIC1-01")).phaseReentries).toBe(1);
  });

  it("writes down what killed the run, with the message redacted", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Crashed",
      requirement: "A dead run leaves something to read.",
    });
    await store.recordDispatchFailure({
      cardId: "S-EPIC1-01", state: "QUEUED", errorClass: "UNKNOWN",
      message: `spawn failed for token sk-${"x".repeat(24)}`,
      attempt: 2, budget: 3, runId: "reentry-S-EPIC1-01",
    });

    const row = (await client.execute(
      "SELECT data FROM event_log WHERE type = 'story.dispatch_failed'",
    )).rows[0];
    const data = JSON.parse(String(row?.data)) as { message: string; attempt: number; errorClass: string };
    expect(data).toMatchObject({ attempt: 2, budget: 3, errorClass: "UNKNOWN", state: "QUEUED" });
    expect(data.message).not.toContain("sk-x");
    expect(data.message).toContain("spawn failed");
  });
});

describe("StoryExecutionStore regression input", () => {
  it("tells a REGRESSION_FIX round which cards it exists for, and leaves every other phase's prompt untouched", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Regression input",
      requirement: "Open cards are the round's tasks.",
      branch: "story/epic1-01",
    });
    await enterDesign(store, "S-EPIC1-01", "run-0");
    await designToCode(store, "S-EPIC1-01", "run-0");
    const before = assemblePhasePrompt(await store.buildPhaseInput("S-EPIC1-01", "CODE", 1));
    await client.execute(
      "INSERT INTO regression_cards (scenario_id, failure_signature, attributed_story, created_at) VALUES ('S-EPIC1-01-a', 'sig', 'S-EPIC1-01', 5)",
    );
    await client.execute(
      "INSERT INTO regression_cards (scenario_id, failure_signature, attributed_story, created_at, resolved_at) VALUES ('S-EPIC1-01-b', 'sig', 'S-EPIC1-01', 5, 6)",
    );

    const fix = await store.buildPhaseInput("S-EPIC1-01", "REGRESSION_FIX", 2);
    expect(fix.regressions).toEqual([{ scenarioId: "S-EPIC1-01-a", signature: "sig", attributedStory: "S-EPIC1-01" }]);
    expect(fix.failedScenarios).toEqual(["S-EPIC1-01-a"]);
    expect(assemblePhasePrompt(fix)).toContain("[regression:S-EPIC1-01-a]");
    expect(assemblePhasePrompt(await store.buildPhaseInput("S-EPIC1-01", "CODE", 1))).toBe(before);
    client.close();
  });
});

describe("StoryExecutionStore narrow specify input", () => {
  it("gives the SPECIFY in front of a regression fix the cards it must reproduce, and an ordinary SPECIFY none", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Narrow specify input",
      requirement: "A reopened card writes one reproduction.",
      branch: "story/epic1-01",
    });
    await enterDesign(store, "S-EPIC1-01", "run-0");
    await client.execute(
      "INSERT INTO regression_cards (scenario_id, failure_signature, attributed_story, created_at) VALUES ('S-EPIC1-01-a', 'sig', 'S-EPIC1-01', 5)",
    );
    await store.transition("S-EPIC1-01", "DESIGN", "SPECIFY", "system", "run-1");

    // On the way to CODE the phase is SPECIFY and the cards stay out of the
    // prompt, so an ordinary contract is written.
    const ordinary = await store.buildPhaseInput("S-EPIC1-01", "SPECIFY", 1);
    expect(ordinary.regressions).toBeUndefined();

    await store.markNarrowSpecify("S-EPIC1-01");
    const narrow = await store.buildPhaseInput("S-EPIC1-01", "SPECIFY", 1);
    expect(narrow.regressions).toEqual([{ scenarioId: "S-EPIC1-01-a", signature: "sig", attributedStory: "S-EPIC1-01" }]);
    expect(assemblePhasePrompt(narrow)).toContain("[regression:S-EPIC1-01-a]");
    client.close();
  });
});

describe("StoryExecutionStore shape retry", () => {
  it("tells the next SHAPE attempt why the last DoD was thrown away", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, (() => { let time = 1_000; return () => time++; })());
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Retry shape",
      requirement: "A refused DoD is a task for the next attempt.",
      branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-0");
    await store.beginPhase({ runId: "run-shape", cardId: "S-EPIC1-01", phase: "SHAPE", round: 1, prompt: "shape" });
    await store.completePhase({ runId: "run-shape", sessionId: "s-shape", artifacts: [{ kind: "dod", body: "story_id: S-EPIC1-01" }] });
    await store.invalidateCompletedPhase("S-EPIC1-01", "SHAPE", 1, "DoD contract is invalid: scenario ids must match the pattern");
    await store.beginPhase({ runId: "run-shape-2", cardId: "S-EPIC1-01", phase: "SHAPE", round: 1, prompt: "shape" });

    const input = await store.buildPhaseInput("S-EPIC1-01", "SHAPE", 1);
    expect(input.previousRejections).toEqual([{ phase: "SHAPE", reason: "DoD contract is invalid: scenario ids must match the pattern" }]);
    expect(assemblePhasePrompt(input)).toContain("[rejected:SHAPE] SHAPE refused the last attempt: DoD contract is invalid");
    client.close();
  });
});

describe("StoryExecutionStore phase input", () => {
  it("tells the next CODE round what the merge gate refused, since only CODE can change it", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Merge gate feedback",
      requirement: "Requirement",
      branch: "story/epic1-01",
    });
    await enterDesign(store, "S-EPIC1-01", "run-0");
    await designToCode(store, "S-EPIC1-01", "run-1");
    await store.transition("S-EPIC1-01", "CODE", "VERIFY", "system", "run-2");
    await store.transition("S-EPIC1-01", "VERIFY", "MERGE", "system", "run-3");
    await store.beginPhase({ runId: "run-merge", cardId: "S-EPIC1-01", phase: "MERGE", round: 1, prompt: "merge" });
    await store.failPhase("run-merge", "git diff --check reported trailing whitespace in src/a.ts:12");

    const input = await store.buildPhaseInput("S-EPIC1-01", "CODE", 2);
    expect(input.previousRejections).toEqual([
      { phase: "MERGE", reason: "git diff --check reported trailing whitespace in src/a.ts:12" },
    ]);
    await store.recordIntegrationRejection(
      "S-EPIC1-01",
      "run-merge",
      "subset re-verification for S-EPIC1-01-a: page returned 404",
      { attribution: "story_regression", failures: ["src/web/page.test.ts > renders the page"] },
    );
    const bounced = await store.buildPhaseInput("S-EPIC1-01", "CODE", 2);
    // The names of what broke travel beside the prose, so the round is not
    // handed 800 bytes of log tail with the one decidable line cut off.
    expect(bounced.previousRejections).toContainEqual({
      phase: "MERGE",
      reason: "the checks failed with this Story on top of the Epic head: subset re-verification for S-EPIC1-01-a: page returned 404",
      failures: ["src/web/page.test.ts > renders the page"],
    });
    const design = await store.buildPhaseInput("S-EPIC1-01", "DESIGN", 2);
    expect(design.previousRejections).toEqual([]);

    // A CODE round that completed after the refusal has answered it, and a
    // round the provider killed was never refused for its approach.
    const current = (await store.getStory("S-EPIC1-01")).state;
    if (current !== "CODE") await store.transition("S-EPIC1-01", current, "CODE", "system", "run-back");
    await store.beginPhase({ runId: "run-code-2", cardId: "S-EPIC1-01", phase: "CODE", round: 2, prompt: "code" });
    await store.completePhase({ runId: "run-code-2", sessionId: "s-code-2", artifacts: [{ kind: "implementation", body: "Whitespace fixed." }] });
    await store.beginPhase({ runId: "run-code-3", cardId: "S-EPIC1-01", phase: "CODE", round: 3, prompt: "code" });
    await store.failPhase("run-code-3", "OAuth refresh failed for openai-codex: token refresh failed (401)");
    const afterwards = await store.buildPhaseInput("S-EPIC1-01", "CODE", 4);
    expect(afterwards.previousRejections).toEqual([]);
    client.close();
  });
});

describe("the frozen contract keeps what a person must see", () => {
  const dod = [
    "story_id: S-EPIC1-01",
    "design_summary: 让人在一页上看清这次执行做了什么。",
    "scenarios:",
    "  - id: S-EPIC1-01-a",
    "    given: 有一次已经跑完的执行",
    "    when: 打开这一页",
    "    then: 能看到这次执行的标题",
    "    layers: [ui]",
    "    source: 执行记录表",
    "    examples:",
    "      - kind: shows",
    "        text: 运行控制台",
    "      - kind: excludes",
    "        text: 还没有任何记录",
    "    visible:",
    "      - role: heading",
    "        text: 运行控制台",
    "  - id: S-EPIC1-01-b",
    "    given: 有一次已经跑完的执行",
    "    when: 读取它的结论",
    "    then: 结论与记录一致",
    "    layers: [unit]",
    "baseline:",
    "  type: acceptance_test",
    "acceptance_criteria:",
    "  - text: 这一页显示本次执行的标题",
    "    scenarios: [S-EPIC1-01-a]",
    "out_of_scope: []",
    "relies_on: []",
    "predicted_footprint: [src/console]",
    "depends_on: []",
  ].join("\n");

  it("records the declaration on the screen scenario and leaves the others empty", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "逐轮执行详情",
      requirement: "人能看清一次执行做了什么。",
      repo: "acme/widget",
      branch: "story/epic1-01",
    });

    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(dod));

    const rows = (await client.execute(
      "SELECT spec_id, visible_json FROM story_specs WHERE story_id = 'S-EPIC1-01' ORDER BY seq",
    )).rows;
    expect(rows).toEqual([
      { spec_id: "S-EPIC1-01-a", visible_json: '[{"role":"heading","text":"运行控制台"}]' },
      { spec_id: "S-EPIC1-01-b", visible_json: null },
    ]);
    client.close();
  });
});

describe("StoryExecutionStore verification completion", () => {
  const card = async (client: Client, store: StoryExecutionStore): Promise<void> => {
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Verify once",
      requirement: "A verified round leaves a verdict behind.",
      branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-0-shape");
    await client.execute("INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES ('S-EPIC1-01-a','S-EPIC1-01',1,'a','pending')");
    await store.transition("S-EPIC1-01", "SHAPE", "DESIGN", "system", "run-0");
    await designToCode(store, "S-EPIC1-01", "run-0");
    await store.transition("S-EPIC1-01", "CODE", "VERIFY", "system", "run-verify-1");
    await store.beginPhase({ runId: "run-verify-1", cardId: "S-EPIC1-01", phase: "VERIFY", round: 1, prompt: "verify" });
  };

  it("refuses the whole write when the verdict names a scenario the card never declared", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await card(client, store);

    await expect(store.completeVerification({
      runId: "run-verify-1",
      sessionId: "s-verify-1",
      artifacts: [{ kind: "verification", body: "{}" }],
      record: {
        cardId: "S-EPIC1-01", round: 1, codeSessionId: "s-code-1", verifySessionId: "s-verify-1",
        verdict: "rejected", failedScenarios: ["S-EPIC1-01-invented"],
      },
    })).rejects.toThrow(/undeclared scenario/);

    // The run is still startable. Completing it first would have made this
    // round unreachable for good: a completed run is reused, never restarted.
    const run = (await client.execute("SELECT status FROM phase_runs WHERE run_id = 'run-verify-1'")).rows[0];
    expect(run).toMatchObject({ status: "running" });
    client.close();
  });

  it("says the round is taken, not that the Story is in the wrong phase, when a completed run holds the slot", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await card(client, store);
    await store.completeVerification({
      runId: "run-verify-1",
      sessionId: "s-verify-1",
      artifacts: [{ kind: "verification", body: "{}" }],
      record: {
        cardId: "S-EPIC1-01", round: 1, codeSessionId: "s-code-1", verifySessionId: "s-verify-1",
        verdict: "rejected", failedScenarios: ["S-EPIC1-01-a"],
      },
    });

    await expect(store.beginPhase({
      runId: "run-verify-1-again", cardId: "S-EPIC1-01", phase: "VERIFY", round: 1, prompt: "verify",
    })).rejects.toThrow(/round 1 .*already completed/);
    client.close();
  });
});

async function reopenedStory(): Promise<{ client: ReturnType<typeof createClient>; store: StoryExecutionStore }> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  let time = 1_000;
  const store = new StoryExecutionStore(client, () => time++);
  await store.createStory({
    id: "S-EPIC1-01",
    notionPageId: "page-1",
    title: "Reopened",
    requirement: "A delivered Story the sweep sent back.",
    branch: "story/epic1-01",
  });
  // What the regression lane does to a delivered card: back to SPECIFY with
  // `phase` naming where this narrow round is headed.
  await client.execute(
    "UPDATE stories SET state = 'SPECIFY', phase = 'REGRESSION_FIX' WHERE id = 'S-EPIC1-01'",
  );
  return { client, store };
}

describe("StoryExecutionStore regression lane across a stop", () => {
  it("gives a released card back the lane it stopped in", async () => {
    // S-R237511OV-01 stopped here and came back as an ordinary round with the
    // full definition of done, delivering without touching the two scenarios
    // it had been reopened for.
    const { client, store } = await reopenedStory();
    await store.stopForInput("S-EPIC1-01", "SPECIFY", "retry_limit_exceeded", "run-stop");
    expect((await client.execute("SELECT phase FROM stories WHERE id = 'S-EPIC1-01'")).rows[0]?.phase)
      .toBe("REGRESSION_FIX");

    await store.transition("S-EPIC1-01", "NEEDS_INPUT", "SPECIFY", "human", "run-human");
    expect((await client.execute("SELECT state, phase FROM stories WHERE id = 'S-EPIC1-01'")).rows[0])
      .toMatchObject({ state: "SPECIFY", phase: "REGRESSION_FIX" });
    client.close();
  });

  it("does not follow a person who sent the card somewhere else", async () => {
    const { client, store } = await reopenedStory();
    await store.stopForInput("S-EPIC1-01", "SPECIFY", "retry_limit_exceeded", "run-stop");

    await store.transition("S-EPIC1-01", "NEEDS_INPUT", "CODE", "human", "run-human");
    expect((await client.execute("SELECT state, phase FROM stories WHERE id = 'S-EPIC1-01'")).rows[0])
      .toMatchObject({ state: "CODE", phase: "CODE" });
    client.close();
  });

  it("keeps the lane across a park and an unpark", async () => {
    const { client, store } = await reopenedStory();
    await store.applyHumanTransition({
      cardId: "S-EPIC1-01", expectedFrom: "SPECIFY", to: "HUMAN_PARKED",
      observedAiStatus: "暂停", humanWinsUntil: 9_000_000, runId: "run-park",
    });
    expect((await client.execute("SELECT phase FROM stories WHERE id = 'S-EPIC1-01'")).rows[0]?.phase)
      .toBe("REGRESSION_FIX");

    await store.applyHumanTransition({
      cardId: "S-EPIC1-01", expectedFrom: "HUMAN_PARKED", to: "SPECIFY",
      observedAiStatus: "进行中", humanWinsUntil: 9_000_000, runId: "run-unpark",
      parkedResumeState: "SPECIFY",
    });
    expect((await client.execute("SELECT state, phase FROM stories WHERE id = 'S-EPIC1-01'")).rows[0])
      .toMatchObject({ state: "SPECIFY", phase: "REGRESSION_FIX" });
    client.close();
  });

  it("leaves an ordinary card's phase following its state", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    const store = new StoryExecutionStore(client, () => time++);
    await store.createStory({
      id: "S-EPIC1-02", notionPageId: "page-2", title: "Ordinary",
      requirement: "A card that was never in the regression lane.", branch: "story/epic1-02",
    });
    await store.transition("S-EPIC1-02", "QUEUED", "SHAPE", "system", "run-shape");
    await store.stopForInput("S-EPIC1-02", "SHAPE", "blocking_question", "run-stop");
    await store.transition("S-EPIC1-02", "NEEDS_INPUT", "SHAPE", "human", "run-human");
    expect((await client.execute("SELECT state, phase FROM stories WHERE id = 'S-EPIC1-02'")).rows[0])
      .toMatchObject({ state: "SHAPE", phase: "SHAPE" });
    client.close();
  });

  it("records the integration branch when it is published and never rewrites one", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    const store = new StoryExecutionStore(client, () => time++);
    await client.execute({
      sql: `INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at)
            VALUES ('E-1', 'page-e1', 'A batch', 'EXECUTING', 1, 1)`,
      args: [],
    });

    await store.recordIntegrationBranch("E-1", "epic/E-1");
    expect((await client.execute("SELECT integration_branch FROM epics WHERE id = 'E-1'")).rows[0])
      .toMatchObject({ integration_branch: "epic/E-1" });

    await store.recordIntegrationBranch("E-1", "epic/somewhere-else");
    expect((await client.execute("SELECT integration_branch FROM epics WHERE id = 'E-1'")).rows[0])
      .toMatchObject({ integration_branch: "epic/E-1" });
    client.close();
  });
});

describe("StoryExecutionStore stop summary over rounds that reached no verdict", () => {
  it("carries the reasons even when something else ended the card", async () => {
    // S-R237511MB-02 stopped on its reopen budget with two inconclusive rounds
    // behind it. The summary read `rounds: []` and said nothing, so the person
    // it stopped for saw a retry count and no reason for it.
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    const store = new StoryExecutionStore(client, () => time++);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Nothing could be judged",
      requirement: "A scenario nobody could put the application into.",
      branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    await client.execute(
      "INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES ('S-EPIC1-01-access','S-EPIC1-01',1,'a','pending')",
    );
    await store.transition("S-EPIC1-01", "SHAPE", "DESIGN", "system", "run-0");
    await designToCode(store, "S-EPIC1-01", "run-0");
    await store.transition("S-EPIC1-01", "CODE", "VERIFY", "system", "run-verify-1");
    await store.beginPhase({ runId: "run-verify-1", cardId: "S-EPIC1-01", phase: "VERIFY", round: 1, prompt: "verify" });
    await store.completePhase({
      runId: "run-verify-1",
      sessionId: "s-verify-1",
      artifacts: [{
        kind: "verification",
        body: JSON.stringify({
          reasons: [{ scenarioId: "S-EPIC1-01-access", reason: "浏览器只能从本机打开，造不出不在允许网络里的设备。" }],
        }),
      }],
    });
    await store.recordVerification("run-verify-1", {
      cardId: "S-EPIC1-01", round: 1, codeSessionId: "s-code-1", verifySessionId: "s-verify-1",
      verdict: "inconclusive", failedScenarios: [],
    });

    await store.stopForInput("S-EPIC1-01", "VERIFY", "retry_limit_exceeded", "run-stop");

    const summary = await store.stopSummary("S-EPIC1-01");
    expect(summary?.inconclusive).toMatchObject({
      attempts: 1,
      rounds: [{
        round: 1,
        reasons: [{ scenarioId: "S-EPIC1-01-access", reason: "浏览器只能从本机打开，造不出不在允许网络里的设备。" }],
      }],
    });
    client.close();
  });
});
