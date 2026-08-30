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
