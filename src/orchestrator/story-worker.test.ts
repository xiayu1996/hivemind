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
  - text: The Story reaches delivered only after an accepted blind verdict.
    scenarios: [S-EPIC1-01-a, S-EPIC1-01-b]
out_of_scope: []
relies_on: []
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

  const designAndCode = vi.fn(async (input: ManagedPhaseInput) => {
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

  it("spends no inner-loop round on a verification the environment lost", async () => {
    const outcomes = [
      { verdict: "inconclusive" as const, failedScenarios: ["S-EPIC1-01-a"], codeFailedScenarios: [] },
      { verdict: "accepted" as const, failedScenarios: [] },
    ];
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => {
        const outcome = outcomes[input.round - 1]!;
        return { sessionId: `session-verify-${input.round}`, artifact: JSON.stringify(outcome), ...outcome };
      }),
    };
    const worker = new SingleStoryWorker(
      store,
      { run: designAndCode },
      verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) },
      { enqueue: vi.fn(async () => undefined) },
    );

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED", stopReason: null });
    // Two rounds ran; the failing one was not charged, so the budget is intact.
    await expect(store.getVerificationFailureHistory("S-EPIC1-01")).resolves.toEqual([]);
    // And the second verification judged the same code as the first: a round
    // the box lost buys no CODE turn, so the HEAD the retry is judged on is
    // the HEAD that was already there.
    const codeRuns = designAndCode.mock.calls.filter(([input]) => input.phase === "CODE");
    expect(codeRuns).toHaveLength(1);
    expect(verifier.run).toHaveBeenCalledTimes(2);
    const codeSessions = new Set(
      (verifier.run as unknown as { mock: { calls: [{ codeSessionId: string }][] } })
        .mock.calls.map(([input]) => input.codeSessionId),
    );
    expect([...codeSessions]).toEqual(["session-code-1"]);
  });

  it("stops for a person after two consecutive attempts lost to the environment, and records the friction", async () => {
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({
        sessionId: `session-verify-${input.round}`,
        artifact: "{}",
        verdict: "inconclusive" as const,
        failedScenarios: ["S-EPIC1-01-a"],
        codeFailedScenarios: [],
      })),
    };
    const friction = { record: vi.fn(async () => undefined) };
    const worker = new SingleStoryWorker(
      store,
      { run: designAndCode },
      verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) },
      { enqueue: vi.fn(async () => undefined) },
      { friction },
    );

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({
      state: "NEEDS_INPUT",
      stopReason: "retry_limit_exceeded",
    });
    expect(friction.record).toHaveBeenCalledWith(expect.objectContaining({
      cardId: "S-EPIC1-01",
      kind: "verification_inconclusive",
    }));
  });

  it("stops before buying another turn once the card has spent its allowance", async () => {
    const phases = vi.fn(designAndCode);
    const worker = new SingleStoryWorker(
      store,
      { run: phases },
      { run: vi.fn(async () => { throw new Error("verification should never be reached"); }) },
      { deliver: vi.fn(async () => ({ mrUrl: null })) },
      { enqueue: vi.fn(async () => undefined) },
      {
        spend: {
          cardSpend: async () => ({ billedUsd: 6, subscriptionUsd: 0 }),
          ceilingUsd: async () => 5,
          spendByPhase: async () => new Map([["CODE", 6]]),
        },
      },
    );

    const result = await worker.run("S-EPIC1-01");
    expect(result).toMatchObject({ state: "NEEDS_INPUT", stopReason: "cost_ceiling_exceeded" });
    // The point of checking before the round: no further turn is bought.
    expect(phases).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "CODE" }));
    expect(result.stopReport).toContain("$6.00 of $5.00");
  });

  it("keeps going when only subscription allowance has been used, which is not money", async () => {
    const worker = new SingleStoryWorker(
      store,
      { run: designAndCode },
      {
        run: vi.fn(async (input) => ({
          sessionId: `session-verify-${input.round}`,
          artifact: "{}",
          verdict: "accepted" as const,
          failedScenarios: [],
        })),
      },
      { deliver: vi.fn(async () => ({ mrUrl: "https://example.invalid/mr/1" })) },
      { enqueue: vi.fn(async () => undefined) },
      {
        spend: {
          cardSpend: async () => ({ billedUsd: 0.2, subscriptionUsd: 400 }),
          ceilingUsd: async () => 5,
        },
      },
    );

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
  });

  it("compares only the code-level failures between rounds", async () => {
    // Round 2 fails on the same code scenario plus one the box lost: as a raw
    // set that is not a proper subset, and the loop would stop on "expanded".
    const outcomes = [
      { verdict: "rejected" as const, failedScenarios: ["S-EPIC1-01-a", "S-EPIC1-01-b"], codeFailedScenarios: ["S-EPIC1-01-a", "S-EPIC1-01-b"] },
      { verdict: "rejected" as const, failedScenarios: ["S-EPIC1-01-a", "S-EPIC1-01-b"], codeFailedScenarios: ["S-EPIC1-01-b"] },
      { verdict: "accepted" as const, failedScenarios: [] },
    ];
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => {
        const outcome = outcomes[input.round - 1]!;
        return { sessionId: `session-verify-${input.round}`, artifact: JSON.stringify(outcome), ...outcome };
      }),
    };
    const worker = new SingleStoryWorker(
      store,
      { run: designAndCode },
      verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) },
      { enqueue: vi.fn(async () => undefined) },
    );

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED", rounds: 3 });
  });

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

  async function spendInnerLoop(): Promise<void> {
    // One real round freezes the DoD through DESIGN; the remaining rounds of the
    // budget are recorded directly, as a long inner loop would have left them.
    const first = new SingleStoryWorker(store, {
      run: async (input: ManagedPhaseInput) => input.phase === "DESIGN"
        ? { sessionId: "session-design", artifacts: [{ kind: "design-summary", body: "Design" }, { kind: "dod", body: DOD }] }
        : { sessionId: "session-code-1", artifacts: [{ kind: "implementation", body: "First" }] },
    }, {
      run: async () => ({ sessionId: "session-verify-1", verdict: "rejected", failedScenarios: ["S-EPIC1-01-a"], artifact: "Failed" }),
    }, { deliver: async () => { throw new Error("delivery must not run"); } }, { enqueue: async () => undefined },
    { maxInnerLoopRounds: 1, runId: (_cardId, phase, round) => `first-${phase}-${round}` });
    await expect(first.run("S-EPIC1-01")).resolves.toMatchObject({ state: "NEEDS_INPUT", rounds: 1 });
    for (let round = 2; round <= 6; round++) {
      await client.execute({
        sql: `INSERT INTO verify_records (card_id, round, code_session_id, verify_session_id, verdict, failed_scenarios, evidence_dir, created_at)
              VALUES ('S-EPIC1-01', ?, ?, ?, 'rejected', '["S-EPIC1-01-a"]', '/ev', 100)`,
        args: [round, `code-${round}`, `verify-${round}`],
      });
    }
    await client.execute("UPDATE stories SET inner_loop_rounds = 6 WHERE id = 'S-EPIC1-01'");
    await store.transition("S-EPIC1-01", "NEEDS_INPUT", "CODE", "human", "human-reopen");
    // The reopen is what puts the card back on CODE, but each test decides
    // whether a person acted since those rounds failed: that mark, not the
    // state, is what grants a new budget.
    await client.execute("UPDATE stories SET last_human_action_at = 0 WHERE id = 'S-EPIC1-01'");
  }

  it("stops cleanly when the Epic head bounces a Story whose inner loop is already spent", async () => {
    await spendInnerLoop();
    const worker = new SingleStoryWorker(store, {
      run: async () => { throw new Error("no phase may run with the budget spent"); },
    }, { run: async () => { throw new Error("no verification may run"); } }, {
      deliver: async () => { throw new Error("delivery must not run"); },
    }, { enqueue: async () => undefined }, { runId: (_cardId, phase, round) => `run-${phase}-${round}` });

    await expect(worker.run("S-EPIC1-01")).resolves.toEqual({
      state: "NEEDS_INPUT",
      rounds: 6,
      mrUrl: null,
      stopReason: "verify_loop_exceeded",
    });
  });

  it("grants a fresh inner loop after a person acted on the card, numbering rounds onward", async () => {
    await spendInnerLoop();
    await client.execute("UPDATE stories SET last_human_action_at = 9000000000000 WHERE id = 'S-EPIC1-01'");
    const seenRounds: number[] = [];
    const phases = {
      run: async (input: ManagedPhaseInput) => {
        seenRounds.push(input.round);
        return {
          sessionId: `session-${input.phase.toLowerCase()}-${input.round}`,
          artifacts: [{ kind: input.phase === "MERGE" ? "delivery-report" : "implementation", body: "Done" }],
        };
      },
    };
    const verifier: StoryVerifyPort = {
      run: async (input) => ({ sessionId: `verify-${input.round}`, verdict: "accepted", failedScenarios: [], artifact: "Fine" }),
    };
    const worker = new SingleStoryWorker(store, phases, verifier, {
      deliver: async () => ({ mrUrl: "https://example.test/mr/7" }),
    }, { enqueue: async () => undefined }, { runId: (_cardId, phase, round) => `run-${phase}-${round}` });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED", rounds: 7 });
    expect(seenRounds[0]).toBe(7);
  });

  it("re-verifies the finished round after a run died inside VERIFY, buying no new CODE turn", async () => {
    const crashing = new SingleStoryWorker(
      store,
      { run: designAndCode },
      { run: async () => { throw new Error("provider transport failed"); } },
      { deliver: async () => { throw new Error("delivery must not run"); } },
      { enqueue: async () => undefined },
      { runId: (_cardId, phase, round) => `crash-${phase}-${round}` },
    );
    await expect(crashing.run("S-EPIC1-01")).rejects.toThrow("provider transport failed");
    expect((await store.getStory("S-EPIC1-01")).state).toBe("VERIFY");

    const seen: string[] = [];
    const resumed = new SingleStoryWorker(
      store,
      {
        run: async (input: ManagedPhaseInput) => {
          seen.push(`${input.phase}:${input.round}`);
          return designAndCode(input);
        },
      },
      { run: async () => ({ sessionId: "session-verify-2", verdict: "accepted", failedScenarios: [], artifact: "Fine" }) },
      { deliver: async () => ({ mrUrl: "https://example.test/mr/9" }) },
      { enqueue: async () => undefined },
      { runId: (_cardId, phase, round) => `resumed-${phase}-${round}` },
    );
    await expect(resumed.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED", rounds: 1 });
    expect(seen).toEqual(["MERGE:1"]);
    // The lost round recorded no verdict, so the budget still has every round
    // and the CODE work it already paid for is reused rather than rewritten.
    expect(await store.getVerificationFailureHistory("S-EPIC1-01")).toEqual([]);
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

  it("designs a CODE Story again when its frozen DoD no longer satisfies the contract", async () => {
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-design");
    await store.beginPhase({ runId: "run-design", cardId: "S-EPIC1-01", phase: "DESIGN", round: 1, prompt: "design" });
    // A DoD frozen under an older contract: no examples, no source, no criteria.
    const stale = "story_id: S-EPIC1-01\nscenarios:\n  - id: S-EPIC1-01-old\n    given: a\n    when: b\n    then: c\n    layer: ui\n";
    await store.completePhase({
      runId: "run-design",
      sessionId: "session-design",
      artifacts: [{ kind: "design-summary", body: "Design" }, { kind: "dod", body: stale }],
    });
    await client.execute("INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES ('S-EPIC1-01-old','S-EPIC1-01',1,'old','pending')");
    await store.transition("S-EPIC1-01", "DESIGN", "CODE", "system", "run-design");

    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "DESIGN") {
        return { sessionId: "session-design-2", artifacts: [{ kind: "design-summary", body: "Design" }, { kind: "dod", body: DOD }] };
      }
      if (input.phase === "CODE") return { sessionId: `session-code-${input.round}`, artifacts: [{ kind: "implementation", body: "done" }] };
      return { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "Both scenarios passed." }] };
    });
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({ sessionId: `session-verify-${input.round}`, verdict: "accepted" as const, failedScenarios: [], artifact: "{}" })),
    };
    const friction = { record: vi.fn(async () => undefined) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) }, { enqueue: vi.fn(async () => undefined) }, { friction });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(phases.mock.calls.map(([input]) => input.phase)).toEqual(["DESIGN", "CODE", "MERGE"]);
    expect(friction.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "dod_contract_changed" }));
    const specs = await client.execute("SELECT spec_id FROM story_specs WHERE story_id = 'S-EPIC1-01' ORDER BY seq");
    expect(specs.rows.map((row) => row.spec_id)).not.toContain("S-EPIC1-01-old");
  });
});

describe("SingleStoryWorker inside an Epic", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    store = new StoryExecutionStore(client, (() => {
      let time = 1_000;
      return () => time++;
    })());
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('EPIC1','epic-page','Epic','EXECUTING',1,1)",
    );
    await store.createStory({
      id: "S-EPIC1-01",
      epicId: "EPIC1",
      notionPageId: "page-1",
      title: "Run one Story",
      requirement: "Execute the full Story pipeline without skipping verification.",
      repo: "xiayu1996/hivemind",
      branch: "story/epic1-01",
    });
  });

  afterEach(() => client.close());

  function ports() {
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "DESIGN") {
        return { sessionId: "session-design", artifacts: [
          { kind: "design-summary", body: "Design" },
          { kind: "dod", body: DOD },
        ] };
      }
      if (input.phase === "CODE") {
        return { sessionId: `session-code-${input.round}`, artifacts: [{ kind: "implementation", body: "done" }] };
      }
      return { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "All scenarios passed." }] };
    });
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({
        sessionId: `session-verify-${input.round}`,
        verdict: "accepted" as const,
        failedScenarios: [],
        artifact: "{}",
      })),
    };
    const delivery = { deliver: vi.fn(async () => ({ mrUrl: null })) };
    return { phases, verifier, delivery, projection: { enqueue: vi.fn(async () => undefined) } };
  }

  it("opens the Story's review request from inside the merge and delivers with its URL", async () => {
    const { phases, verifier, projection } = ports();
    const delivery = { deliver: vi.fn(async () => ({ mrUrl: "https://example.test/pull/3" })) };
    const integration = {
      integrate: vi.fn(async (_cardId: string, _runId: string, publish?: () => Promise<{ mrUrl: string | null }>) => ({
        kind: "merged",
        mrUrl: (await publish!()).mrUrl,
      })),
    };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({
      state: "DELIVERED",
      mrUrl: "https://example.test/pull/3",
    });
    expect(integration.integrate).toHaveBeenCalledOnce();
    expect(delivery.deliver).toHaveBeenCalledOnce();
    expect((await store.getStory("S-EPIC1-01")).mrUrl).toBe("https://example.test/pull/3");
  });

  it("does not deliver a Story the Epic head refused", async () => {
    const { phases, verifier, delivery, projection } = ports();
    const integration = { integrate: vi.fn(async () => ({ kind: "conflict", reason: "CONFLICT in src/a" })) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "CODE", mrUrl: null });
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it("leaves a Story with no Epic to its own delivery path", async () => {
    await client.execute("UPDATE stories SET epic_id = NULL WHERE id = 'S-EPIC1-01'");
    const { phases, verifier, delivery, projection } = ports();
    const integration = { integrate: vi.fn(async () => ({ kind: "merged" })) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(integration.integrate).not.toHaveBeenCalled();
  });
});

function regressionPorts(accept: boolean) {
  const phases = vi.fn(async (input: ManagedPhaseInput) => ({
    sessionId: `session-fix-${input.round}`,
    artifacts: [{ kind: "implementation", body: "fixed" }],
  }));
  const verifier: StoryVerifyPort = {
    run: vi.fn(async (input) => ({
      sessionId: `session-verify-${input.round}`,
      verdict: accept ? "accepted" as const : "rejected" as const,
      failedScenarios: accept ? [] : ["S-EPIC1-01-a"],
      artifact: "{}",
    })),
  };
  const integration = { integrate: vi.fn(async () => ({ kind: "merged", mrUrl: null })) };
  const delivery = { deliver: vi.fn(async () => ({ mrUrl: null })) };
  const projection = { enqueue: vi.fn(async () => undefined) };
  return { phases, verifier, integration, delivery, projection };
}

describe("SingleStoryWorker regression fix", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;

  async function deliveredStory(): Promise<void> {
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, integration_branch, created_at, updated_at) VALUES ('EPIC1','epic-page','Epic','EXECUTING','epic/EPIC1',1,1)",
    );
    await store.createStory({
      id: "S-EPIC1-01", epicId: "EPIC1", notionPageId: "page-1", title: "Fix a regression",
      requirement: "A delivered Story whose scenario broke on the Epic head fixes it.",
      repo: "xiayu1996/hivemind", branch: "story/epic1-01",
    });
    await store.transition("S-EPIC1-01", "QUEUED", "DESIGN", "system", "run-design");
    await store.beginPhase({ runId: "run-design", cardId: "S-EPIC1-01", phase: "DESIGN", round: 1, prompt: "design" });
    await store.completePhase({ runId: "run-design", sessionId: "s-design", artifacts: [{ kind: "dod", body: DOD }] });
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(DOD));
    await client.execute("UPDATE stories SET state = 'DELIVERED', phase = NULL, inner_loop_rounds = 3, mr_url = 'https://example.test/pull/1' WHERE id = 'S-EPIC1-01'");
    await store.transition("S-EPIC1-01", "DELIVERED", "REGRESSION_FIX", "system", "run-attributed");
  }

  async function openCard(scenarioId = "S-EPIC1-01-a", signature = "sig-1"): Promise<void> {
    await client.execute({
      sql: "INSERT INTO regression_cards (scenario_id, failure_signature, attributed_story, created_at) VALUES (?, ?, 'S-EPIC1-01', 5)",
      args: [scenarioId, signature],
    });
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    store = new StoryExecutionStore(client, (() => { let time = 1_000; return () => time++; })());
    await deliveredStory();
  });

  afterEach(() => client.close());

  it("fixes the attributed scenario, lands it again, closes the card and returns to DELIVERED", async () => {
    await openCard();
    const { phases, verifier, integration, delivery, projection } = regressionPorts(true);
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED", rounds: 4, mrUrl: "https://example.test/pull/1" });
    const [input] = phases.mock.calls[0]!;
    expect(input.phase).toBe("REGRESSION_FIX");
    expect(input.round).toBe(4);
    expect(input.prompt).toContain("[regression:S-EPIC1-01-a]");
    expect(input.context.failedScenarios).toEqual(["S-EPIC1-01-a"]);
    // The verifier only re-runs what the cards name.
    const verifyInput = (verifier.run as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { definitionOfDone: { scenarios: Array<{ id: string }> } };
    expect(verifyInput.definitionOfDone.scenarios.map((scenario) => scenario.id)).toEqual(["S-EPIC1-01-a"]);
    expect(integration.integrate).toHaveBeenCalledOnce();
    const card = (await client.execute("SELECT resolved_at FROM regression_cards")).rows[0];
    expect(card?.resolved_at).not.toBeNull();
    expect(await store.getStory("S-EPIC1-01")).toMatchObject({ state: "DELIVERED", regressionReopens: 1 });
  });

  it("stops for a person when the fix never satisfies the verifier, leaving the card open", async () => {
    await openCard();
    const { phases, verifier, integration, delivery, projection } = regressionPorts(false);
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration, maxInnerLoopRounds: 2 });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "NEEDS_INPUT", stopReason: "verify_loop_exceeded" });
    expect(integration.integrate).not.toHaveBeenCalled();
    expect((await client.execute("SELECT resolved_at FROM regression_cards")).rows[0]?.resolved_at).toBeNull();
    expect(await store.getStory("S-EPIC1-01")).toMatchObject({ state: "NEEDS_INPUT", resumeState: "REGRESSION_FIX" });
  });

  it("refuses to reopen a Story past the reopen ceiling without spending a round", async () => {
    await openCard();
    await client.execute("UPDATE stories SET regression_reopens = 2 WHERE id = 'S-EPIC1-01'");
    const { phases, verifier, integration, delivery, projection } = regressionPorts(true);
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration, maxRegressionReopens: 2 });

    const result = await worker.run("S-EPIC1-01");
    expect(result).toMatchObject({ state: "NEEDS_INPUT" });
    expect(result.stopReport).toContain("retry.maxRegressionReopens");
    expect(phases).not.toHaveBeenCalled();
    expect(await store.getStory("S-EPIC1-01")).toMatchObject({ stopReason: "retry_limit_exceeded" });
  });

  it("returns straight to DELIVERED when nothing is left to fix", async () => {
    const { phases, verifier, integration, delivery, projection } = regressionPorts(true);
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(phases).not.toHaveBeenCalled();
  });

  it("keeps trying when the Epic head refuses the fix, with the refusal as the next round's task", async () => {
    await openCard();
    const { phases, verifier, delivery, projection } = regressionPorts(true);
    // The integrator records the refusal in the real flow; the fake stands in for it here.
    const integration = { integrate: vi.fn()
      .mockImplementationOnce(async (_card: string, runId: string) => {
        await store.recordRegressionLandingFailure("S-EPIC1-01", runId, "subset re-verification on epic/EPIC1 failed for S-EPIC1-01-b");
        return { kind: "verification_failed" };
      })
      .mockResolvedValueOnce({ kind: "merged", mrUrl: null }) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED", rounds: 5 });
    expect(phases).toHaveBeenCalledTimes(2);
    expect(phases.mock.calls[1]![0].prompt).toContain("re-verification on the Epic head failed");
  });
});

