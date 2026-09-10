import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { assemblePhasePrompt } from "../pipeline/phase-input.js";
import { StoryExecutionStore } from "./story-execution-store.js";

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
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-design");
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      state: "DESIGN",
      phase: "DESIGN",
      requirement: "A later phase can rebuild all prior inputs from the central database.",
    });
    await expect(
      store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "lost-race"),
    ).rejects.toThrow(/lost a race/);
    const events = await client.execute(
      "SELECT type, data FROM event_log WHERE run_id = 'run-design' ORDER BY seq",
    );
    expect(events.rows).toMatchObject([{
      type: "story.transition",
      data: JSON.stringify({ from: "QUEUED", to: "DESIGN", actor: "system" }),
    }]);
  });

  it("persists a completed phase and rebuilds a byte-identical later prompt without local files", async () => {
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-design");
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
    await store.transition("S-EPIC1-01", "DESIGN", "CODE", "system", "run-code");

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
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-design");
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
    await store.transition("S-M2-05-conflict", "QUEUED", "DESIGN", "system", "design");
    await store.transition("S-M2-05-conflict", "DESIGN", "CODE", "system", "code");
    await store.transition("S-M2-05-conflict", "CODE", "VERIFY", "system", "verify");
    await store.transition("S-M2-05-conflict", "VERIFY", "MERGE", "system", "merge");
  });
  afterEach(() => client.close());

  it("S-M2-05-conflict returns an unresolved rebase conflict to CODE and records it without delivering", async () => {
    await store.recordMergeConflict("S-M2-05-conflict", "merge-run", "CONFLICT (content): Merge conflict in src/vcs/merge-flow.ts");
    await expect(store.getStory("S-M2-05-conflict")).resolves.toMatchObject({ state: "CODE", phase: "CODE", mrUrl: null });
    await expect(client.execute("SELECT type, data FROM event_log WHERE run_id = 'merge-run'")).resolves.toMatchObject({
      rows: [{ type: "merge.conflict", data: JSON.stringify({ reason: "CONFLICT (content): Merge conflict in src/vcs/merge-flow.ts" }) }],
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
    await store.transition("S-MQ-10-resume", "QUEUED", "DESIGN", "system", "design");
    const beforeResume = await store.getStory("S-MQ-10-resume");
    expect(beforeResume.lastHumanActionAt ?? null).toBeNull();
    await store.transition("S-MQ-10-resume", "DESIGN", "CODE", "human", "resume");
    const afterResume = await store.getStory("S-MQ-10-resume");
    expect(afterResume.lastHumanActionAt).toBeGreaterThan(0);
  });

  it("leaves the mark alone when the system moves the card", async () => {
    await store.transition("S-MQ-10-resume", "QUEUED", "DESIGN", "human", "human-start");
    const stamped = (await store.getStory("S-MQ-10-resume")).lastHumanActionAt;
    await store.transition("S-MQ-10-resume", "DESIGN", "CODE", "system", "code");
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
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-0");
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
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-0");
    await store.beginPhase({ runId: "run-design", cardId: "S-EPIC1-01", phase: "DESIGN", round: 1, prompt: "design" });
    await store.completePhase({ runId: "run-design", sessionId: "session-design", artifacts: [{ kind: "dod", body: "story_id: S-EPIC1-01" }] });

    await store.invalidateCompletedPhase("S-EPIC1-01", "DESIGN", 1, "DoD is missing a scenario id");

    const events = (await client.execute(
      "SELECT run_id, type, data FROM event_log WHERE type = 'phase.invalidated'",
    )).rows;
    expect(events).toMatchObject([{
      run_id: "run-design",
      data: JSON.stringify({ round: 1, reason: "DoD is missing a scenario id" }),
    }]);
    client.close();
  });
});

describe("StoryExecutionStore redesign", () => {
  it("unfreezes the DoD and discards reusable results when a person sends the Story back to DESIGN", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    const store = new StoryExecutionStore(client, () => time++);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Redesign",
      requirement: "A Story sent back to DESIGN is designed again.",
      branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-0");
    await store.beginPhase({ runId: "run-design", cardId: "S-EPIC1-01", phase: "DESIGN", round: 1, prompt: "design" });
    await store.completePhase({ runId: "run-design", sessionId: "s-design", artifacts: [{ kind: "dod", body: "story_id: S-EPIC1-01" }] });
    await client.execute("INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES ('S-EPIC1-01-a','S-EPIC1-01',1,'a','pending')");
    await store.transition("S-EPIC1-01", "DESIGN", "CODE", "system", "run-0");
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

    await store.transition("S-EPIC1-01", "NEEDS_INPUT", "DESIGN", "human", "run-human");

    expect(await store.getCompletedPhase("S-EPIC1-01", "DESIGN", 1)).toBeNull();
    expect(await store.getCompletedPhase("S-EPIC1-01", "CODE", 2)).toBeNull();
    expect(await store.getCompletedPhase("S-EPIC1-01", "CODE", 1)).not.toBeNull();
    expect(await store.findFrozenDefinitionOfDone("S-EPIC1-01")).toBeNull();
    const events = (await client.execute("SELECT type FROM event_log WHERE type IN ('story.redesign','phase.invalidated') ORDER BY type")).rows;
    expect(events.map((row) => row.type)).toEqual(["phase.invalidated", "phase.invalidated", "story.redesign"]);
    client.close();
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
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-0");
    await store.transition("S-EPIC1-01", "DESIGN", "CODE", "system", "run-0");
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

describe("StoryExecutionStore design retry", () => {
  it("tells the next DESIGN attempt why the last DoD was thrown away", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, (() => { let time = 1_000; return () => time++; })());
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Retry design",
      requirement: "A refused DoD is a task for the next attempt.",
      branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-0");
    await store.beginPhase({ runId: "run-design", cardId: "S-EPIC1-01", phase: "DESIGN", round: 1, prompt: "design" });
    await store.completePhase({ runId: "run-design", sessionId: "s-design", artifacts: [{ kind: "dod", body: "story_id: S-EPIC1-01" }] });
    await store.invalidateCompletedPhase("S-EPIC1-01", "DESIGN", 1, "DoD contract is invalid: scenario ids must match the pattern");
    await store.beginPhase({ runId: "run-design-2", cardId: "S-EPIC1-01", phase: "DESIGN", round: 1, prompt: "design" });

    const input = await store.buildPhaseInput("S-EPIC1-01", "DESIGN", 1);
    expect(input.previousRejections).toEqual([{ phase: "DESIGN", reason: "DoD contract is invalid: scenario ids must match the pattern" }]);
    expect(assemblePhasePrompt(input)).toContain("[rejected:DESIGN] DESIGN refused the last attempt: DoD contract is invalid");
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
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-0");
    await store.transition("S-EPIC1-01", "DESIGN", "CODE", "system", "run-1");
    await store.transition("S-EPIC1-01", "CODE", "VERIFY", "system", "run-2");
    await store.transition("S-EPIC1-01", "VERIFY", "MERGE", "system", "run-3");
    await store.beginPhase({ runId: "run-merge", cardId: "S-EPIC1-01", phase: "MERGE", round: 1, prompt: "merge" });
    await store.failPhase("run-merge", "git diff --check reported trailing whitespace in src/a.ts:12");

    const input = await store.buildPhaseInput("S-EPIC1-01", "CODE", 2);
    expect(input.previousRejections).toEqual([
      { phase: "MERGE", reason: "git diff --check reported trailing whitespace in src/a.ts:12" },
    ]);
    await store.recordIntegrationRejection("S-EPIC1-01", "run-merge", "subset re-verification on epic/EPIC1 failed for S-EPIC1-01-a: page returned 404");
    const bounced = await store.buildPhaseInput("S-EPIC1-01", "CODE", 2);
    expect(bounced.previousRejections).toContainEqual({
      phase: "MERGE",
      reason: "re-verification on the Epic head failed: subset re-verification on epic/EPIC1 failed for S-EPIC1-01-a: page returned 404",
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
