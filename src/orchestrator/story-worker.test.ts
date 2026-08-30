import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { parseDoD } from "../pipeline/dod.js";
import { StoryExecutionStore } from "./story-execution-store.js";
import {
  SingleStoryWorker,
  type ManagedPhaseInput,
  type StoryVerifyPort,
} from "./story-worker.js";

const DOD = `story_id: S-EPIC1-01
design_summary: Persist every phase output centrally.
scenarios:
  - id: S-EPIC1-01-a
    given: A completed phase
    when: the next phase starts
    then: its prompt contains the earlier artifact
    layers: [integration]
  - id: S-EPIC1-01-b
    given: Verification rejects the implementation
    when: another round runs
    then: the failure set strictly shrinks
    layers: [unit]
baseline:
  type: acceptance_test
acceptance_criteria:
  - The Story reaches delivered only after an accepted blind verdict.
predicted_footprint: [src/orchestrator]
depends_on: []
`;

describe("SingleStoryWorker", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    store = new StoryExecutionStore(client, (() => {
      let time = 1_000;
      return () => time++;
    })());
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Run one Story",
      requirement: "Execute the full Story pipeline without skipping verification.",
      repo: "xiayu1996/hivemind",
      branch: "story/epic1-01",
    });
  });

  afterEach(() => client.close());

  it("runs DESIGN, a converging CODE/VERIFY loop, MERGE and delivery", async () => {
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "DESIGN") {
        return {
          sessionId: "session-design",
          artifacts: [
            { kind: "design-summary", body: "Use central phase artifacts." },
            { kind: "dod", body: DOD },
          ],
        };
      }
      if (input.phase === "CODE") {
        expect(input.prompt).toContain("DESIGN / dod");
        return {
          sessionId: `session-code-${input.round}`,
          artifacts: [{ kind: "implementation", body: `Implementation round ${input.round}` }],
        };
      }
      return {
        sessionId: "session-merge",
        artifacts: [{ kind: "delivery-report", body: "Both scenarios passed." }],
      };
    });
    const outcomes = [
      { verdict: "rejected" as const, failedScenarios: ["S-EPIC1-01-a", "S-EPIC1-01-b"] },
      { verdict: "rejected" as const, failedScenarios: ["S-EPIC1-01-b"] },
      { verdict: "accepted" as const, failedScenarios: [] },
    ];
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => {
        const outcome = outcomes[input.round - 1]!;
        return {
          sessionId: `session-verify-${input.round}`,
          artifact: JSON.stringify(outcome),
          ...outcome,
        };
      }),
    };
    const delivery = { deliver: vi.fn(async () => ({ mrUrl: "https://github.com/example/repo/pull/1" })) };
    let runSequence = 0;
    const projection = { enqueue: vi.fn(async () => undefined) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, {
      runId: (_cardId, phase, round) => `run-${++runSequence}-${phase}-${round}`,
    });

    await expect(worker.run("S-EPIC1-01")).resolves.toEqual({
      state: "DELIVERED",
      rounds: 3,
      mrUrl: "https://github.com/example/repo/pull/1",
      stopReason: null,
    });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      state: "DELIVERED",
      innerLoopRounds: 3,
      mrUrl: "https://github.com/example/repo/pull/1",
    });
    expect(phases.mock.calls.map(([input]) => `${input.phase}:${input.round}`)).toEqual([
      "DESIGN:1", "CODE:1", "CODE:2", "CODE:3", "MERGE:1",
    ]);
    expect(projection.enqueue).toHaveBeenCalledTimes(5);
    const records = await client.execute(
      "SELECT code_session_id, verify_session_id, verdict FROM verify_records ORDER BY round",
    );
    expect(records.rows).toMatchObject([
      { code_session_id: "session-code-1", verify_session_id: "session-verify-1", verdict: "rejected" },
      { code_session_id: "session-code-2", verify_session_id: "session-verify-2", verdict: "rejected" },
      { code_session_id: "session-code-3", verify_session_id: "session-verify-3", verdict: "accepted" },
    ]);
    const specs = await client.execute("SELECT spec_id, status FROM story_specs ORDER BY seq");
    expect(specs.rows).toMatchObject([
      { spec_id: "S-EPIC1-01-a", status: "passed" },
      { spec_id: "S-EPIC1-01-b", status: "passed" },
    ]);
  });

  it("stops at the only verification stop when the failure set stalls", async () => {
    const phases = {
      run: async (input: ManagedPhaseInput) => input.phase === "DESIGN"
        ? {
            sessionId: "session-design",
            artifacts: [
              { kind: "design-summary", body: "Design" },
              { kind: "dod", body: DOD },
            ],
          }
        : {
            sessionId: `session-${input.phase.toLowerCase()}-${input.round}`,
            artifacts: [{ kind: "implementation", body: "Implementation" }],
          },
    };
    const verifier: StoryVerifyPort = {
      run: async (input) => ({
        sessionId: `verify-${input.round}`,
        verdict: "rejected",
        failedScenarios: ["S-EPIC1-01-a"],
        artifact: "Still failing",
      }),
    };
    const worker = new SingleStoryWorker(store, phases, verifier, {
      deliver: async () => { throw new Error("delivery must not run"); },
    }, { enqueue: async () => undefined }, { runId: (_cardId, phase, round) => `run-${phase}-${round}` });

    await expect(worker.run("S-EPIC1-01")).resolves.toEqual({
      state: "NEEDS_INPUT",
      rounds: 2,
      mrUrl: null,
      stopReason: "verify_loop_exceeded",
    });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      state: "NEEDS_INPUT",
      stopReason: "verify_loop_exceeded",
    });
  });

  it("resumes a reopened CODE state from central DoD and verification history", async () => {
    const initialPhases = {
      run: async (input: ManagedPhaseInput) => input.phase === "DESIGN"
        ? {
            sessionId: "session-design",
            artifacts: [
              { kind: "design-summary", body: "Design" },
              { kind: "dod", body: DOD },
            ],
          }
        : {
            sessionId: "session-code-1",
            artifacts: [{ kind: "implementation", body: "First implementation" }],
          },
    };
    const rejected: StoryVerifyPort = {
      run: async () => ({
        sessionId: "session-verify-1",
        verdict: "rejected",
        failedScenarios: ["S-EPIC1-01-a"],
        artifact: "One scenario failed",
      }),
    };
    const first = new SingleStoryWorker(
      store,
      initialPhases,
      rejected,
      { deliver: async () => { throw new Error("delivery must not run"); } },
      { enqueue: async () => undefined },
      { maxInnerLoopRounds: 1, runId: (_cardId, phase, round) => `first-${phase}-${round}` },
    );
    await expect(first.run("S-EPIC1-01")).resolves.toMatchObject({ state: "NEEDS_INPUT", rounds: 1 });
    await store.transition("S-EPIC1-01", "NEEDS_INPUT", "CODE", "human", "human-reopen");

    const resumedPhases = vi.fn(async (input: ManagedPhaseInput) => input.phase === "CODE"
      ? {
          sessionId: "session-code-2",
          artifacts: [{ kind: "implementation", body: "Second implementation" }],
        }
      : {
          sessionId: "session-merge",
          artifacts: [{ kind: "delivery-report", body: "Accepted after feedback" }],
        });
    const resumed = new SingleStoryWorker(
      store,
      { run: resumedPhases },
      {
        run: async () => ({
          sessionId: "session-verify-2",
          verdict: "accepted",
          failedScenarios: [],
          artifact: "All scenarios passed",
        }),
      },
      { deliver: async () => ({ mrUrl: "https://github.com/example/repo/pull/2" }) },
      { enqueue: async () => undefined },
      { runId: (_cardId, phase, round) => `resumed-${phase}-${round}` },
    );

    await expect(resumed.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED", rounds: 2 });
    expect(resumedPhases.mock.calls.map(([input]) => `${input.phase}:${input.round}`)).toEqual([
      "CODE:2",
      "MERGE:1",
    ]);
    const records = await client.execute("SELECT round, verdict FROM verify_records ORDER BY round");
    expect(records.rows).toMatchObject([
      { round: 1, verdict: "rejected" },
      { round: 2, verdict: "accepted" },
    ]);
  });
});

describe("SingleStoryWorker DESIGN re-entry after a crash", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    store = new StoryExecutionStore(client, (() => {
      let time = 1_000;
      return () => time++;
    })());
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Run one Story",
      requirement: "Execute the full Story pipeline without skipping verification.",
      repo: "xiayu1996/hivemind",
      branch: "story/epic1-01",
    });
  });

  afterEach(() => client.close());

  it("reuses the frozen Definition of Done instead of burning DESIGN sessions against it", async () => {
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-design");
    await store.beginPhase({ runId: "run-design", cardId: "S-EPIC1-01", phase: "DESIGN", round: 1, prompt: "design" });
    await store.completePhase({
      runId: "run-design",
      sessionId: "session-design",
      artifacts: [{ kind: "design-summary", body: "Design" }, { kind: "dod", body: DOD }],
    });
    // The crash lands here: the setpoint is frozen but the Story never left DESIGN.
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(DOD));

    const phases = vi.fn(async (input: ManagedPhaseInput) => (input.phase === "CODE"
      ? { sessionId: `session-code-${input.round}`, artifacts: [{ kind: "implementation", body: "done" }] }
      : { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "Both scenarios passed." }] }));
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({
        sessionId: `session-verify-${input.round}`,
        verdict: "accepted" as const,
        failedScenarios: [],
        artifact: "{}",
      })),
    };
    const worker = new SingleStoryWorker(
      store,
      { run: phases },
      verifier,
      { deliver: vi.fn(async () => ({ mrUrl: "https://example.test/pull/1" })) },
      { enqueue: vi.fn(async () => undefined) },
    );

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(phases.mock.calls.map(([input]) => input.phase)).not.toContain("DESIGN");
    const artifacts = await client.execute(
      "SELECT kind FROM phase_artifacts WHERE card_id = 'S-EPIC1-01' AND phase = 'DESIGN' ORDER BY kind",
    );
    expect(artifacts.rows).toMatchObject([{ kind: "design-summary" }, { kind: "dod" }]);
  });
});
