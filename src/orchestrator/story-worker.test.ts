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
design_summary: 每个阶段的产出都存在中央库里，下一个阶段开始时能读到上一个阶段留下的东西。
scenarios:
  - id: S-EPIC1-01-a
    title: 上一阶段的产出还在
    given: 一个阶段已经做完
    when: 下一个阶段开始
    then: 它能读到上一阶段留下的产出
    layers: [integration]
  - id: S-EPIC1-01-b
    title: 打回后问题变少
    given: 验证打回了这次实现
    when: 再跑一轮
    then: 没通过的场景比上一轮更少
    layers: [unit]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: 只有验证通过之后，这张卡才算交付。
    scenarios: [S-EPIC1-01-a, S-EPIC1-01-b]
out_of_scope: []
relies_on: []
predicted_footprint: [src/orchestrator]
depends_on: []
`;

const TEST_CONTRACT = `story_id: S-EPIC1-01
mode: full
scenarios:
  - id: S-EPIC1-01-a
    layer: integration
    cases:
      - name: "@scenario S-EPIC1-01-a carries the earlier artifact forward"
        kind: happy
        asserts: the CODE prompt contains the DESIGN artifact verbatim
      - name: "@scenario S-EPIC1-01-a with no earlier artifact"
        kind: negative
        asserts: assembling refuses rather than emitting an empty section
    expected_failure:
      file: src/pipeline/phase-input.test.ts:12
      assertion: expect(prompt).toContain("DESIGN / dod")
      actual: "undefined"
  - id: S-EPIC1-01-b
    layer: unit
    cases:
      - name: "@scenario S-EPIC1-01-b shrinking failure set"
        kind: happy
        asserts: a strictly smaller failure set may continue
      - name: "@scenario S-EPIC1-01-b equal failure set"
        kind: boundary
        asserts: an equal failure set stops the loop
    expected_failure:
      file: src/pipeline/convergence.test.ts:8
      assertion: expect(result.mayContinue).toBe(false)
      actual: "true"
`;

const NARROW_CONTRACT = `story_id: S-EPIC1-01
mode: narrow
scenarios:
  - id: S-EPIC1-01-a
    layer: integration
    cases:
      - name: "@scenario S-EPIC1-01-a reproduces the reported break"
        kind: happy
        asserts: the artifact reaches the next phase again
      - name: "@scenario S-EPIC1-01-a with the artifact removed"
        kind: negative
        asserts: the assembler refuses rather than emitting an empty section
    expected_failure:
      file: src/pipeline/phase-input.test.ts:40
      assertion: expect(prompt).toContain("DESIGN / dod")
      actual: "undefined"
`;

/**
 * The three phases in front of the inner loop: SHAPE freezes the acceptance
 * contract, DESIGN reads it frozen, SPECIFY turns it into tests. Returns null
 * for every other phase so each test only says what its own loop does.
 */
function frontPhase(input: ManagedPhaseInput, dod: string = DOD) {
  switch (input.phase) {
    case "SHAPE":
      return {
        sessionId: "session-shape",
        artifacts: [
          { kind: "dod", body: dod },
          { kind: "open-questions", body: "[]" },
        ],
      };
    case "DESIGN":
      return {
        sessionId: "session-design",
        artifacts: [
          { kind: "design-summary", body: "Use central phase artifacts." },
          { kind: "declarations", body: "[]" },
        ],
      };
    case "SPECIFY":
      return {
        sessionId: "session-specify",
        artifacts: [{ kind: "test-contract", body: TEST_CONTRACT }],
      };
    default:
      return null;
  }
}

/** The same DoD with its first scenario judged on a screen. A screen scenario
 * owes examples, a source, the page it is served at and the roles it shows,
 * so all five are here. */
function withScreens(dod: string): string {
  return dod.replace("    layers: [integration]", [
    "    layers: [ui]",
    "    source: the stories table",
    "    examples:",
    "      - kind: shows",
    "        text: 新建任务",
    "      - kind: excludes",
    "        text: 还没有任何任务",
    "    page: /tasks",
    "    visible:",
    "      - role: button",
    "        text: 新建任务",
  ].join("\n"));
}

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
    const front = frontPhase(input);
    if (front) return front;
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

  it("stops a card that has screens for a person when the branch has no interface contract", async () => {
    const screens = withScreens(DOD);
    const friction = { record: vi.fn(async () => undefined) };
    const worker = new SingleStoryWorker(
      store,
      { run: (input: ManagedPhaseInput) => Promise.resolve(frontPhase(input, screens) ?? { sessionId: "x", artifacts: [] }) },
      { run: vi.fn() } as unknown as StoryVerifyPort,
      { deliver: vi.fn(async () => ({ mrUrl: null })) },
      { enqueue: vi.fn(async () => undefined) },
      { friction, interfaceContract: async () => null },
    );

    const result = await worker.run("S-EPIC1-01");

    expect(result).toMatchObject({ state: "NEEDS_INPUT", stopReason: "blocking_question" });
    expect(result.stopReport).toContain("界面契约");
    expect(friction.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "interface_contract_missing" }));
  });

  it("lets a card with screens through once the contract is on the branch", async () => {
    const screens = withScreens(DOD);
    const verifier: StoryVerifyPort = {
      run: vi.fn(async () => ({
        sessionId: "session-verify",
        verdict: "accepted" as const,
        failedScenarios: [],
        artifact: "两个场景都过了。",
      })),
    };
    const worker = new SingleStoryWorker(
      store,
      { run: (input: ManagedPhaseInput) => Promise.resolve(frontPhase(input, screens) ?? (
        input.phase === "CODE"
          ? { sessionId: "session-code-1", artifacts: [{ kind: "implementation", body: "done" }] }
          : { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "交付了。" }] }
      )) },
      verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) },
      { enqueue: vi.fn(async () => undefined) },
      {
        interfaceContract: async () => ({
          tokens: [{ name: "color.surface", type: "color", value: "#111827" }],
          components: "# 组件",
          design: "# 为什么长这样\n\n这一批页面服务的是值班的人。",
          pages: [{ file: "pages/board.html", name: "任务看板", purpose: "看今天要做什么" }],
        }),
      },
    );

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
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

  it("runs the front phases, a converging CODE/VERIFY loop, MERGE and delivery", async () => {
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      const front = frontPhase(input);
      if (front) return front;
      if (input.phase === "CODE") {
        expect(input.prompt).toContain("SHAPE / dod");
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
      "SHAPE:1", "DESIGN:1", "SPECIFY:1", "CODE:1", "CODE:2", "CODE:3", "MERGE:1",
    ]);
    expect(projection.enqueue).toHaveBeenCalledTimes(7);
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

  it("spends a round and keeps going when a round trades one failure for another", async () => {
    // Round 2 fixes scenario a and breaks b. The old rule read that as
    // expansion and stopped a card that was two thirds of the way done.
    const outcomes = [
      { verdict: "rejected" as const, failedScenarios: ["S-EPIC1-01-a"] },
      { verdict: "rejected" as const, failedScenarios: ["S-EPIC1-01-b"] },
      { verdict: "accepted" as const, failedScenarios: [] },
    ];
    const verifier: StoryVerifyPort = {
      run: async (input) => {
        const outcome = outcomes[input.round - 1]!;
        return { sessionId: `session-verify-${input.round}`, artifact: JSON.stringify(outcome), ...outcome };
      },
    };
    const worker = new SingleStoryWorker(
      store,
      { run: designAndCode },
      verifier,
      { deliver: async () => ({ mrUrl: null }) },
      { enqueue: async () => undefined },
    );

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED", rounds: 3 });
  });

  it("stops on the budget, not the loop, when the failure set keeps moving to the last round", async () => {
    const outcomes = [
      ["S-EPIC1-01-a"],
      ["S-EPIC1-01-b"],
      ["S-EPIC1-01-a", "S-EPIC1-01-b"],
    ];
    const verifier: StoryVerifyPort = {
      run: async (input) => ({
        sessionId: `verify-${input.round}`,
        verdict: "rejected",
        failedScenarios: outcomes[input.round - 1]!,
        artifact: "Still failing",
      }),
    };
    const worker = new SingleStoryWorker(store, { run: designAndCode }, verifier, {
      deliver: async () => { throw new Error("delivery must not run"); },
    }, { enqueue: async () => undefined }, { runId: (_cardId, phase, round) => `run-${phase}-${round}` });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({
      state: "NEEDS_INPUT",
      rounds: 3,
      stopReason: "retry_limit_exceeded",
      convergence: "budget_exhausted",
    });
    const stopped = JSON.parse(String((await client.execute(
      "SELECT data FROM event_log WHERE type = 'story.stopped' ORDER BY id DESC LIMIT 1",
    )).rows[0]?.data)) as { reason: string; convergence: string; spent: number; budget: number };
    expect(stopped).toMatchObject({
      reason: "retry_limit_exceeded", convergence: "budget_exhausted", spent: 3, budget: 3,
    });
  });

  it("stops at the only verification stop when the failure set stalls", async () => {
    const phases = {
      run: async (input: ManagedPhaseInput) => frontPhase(input) ?? {
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

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({
      state: "NEEDS_INPUT",
      rounds: 2,
      mrUrl: null,
      stopReason: "verify_loop_exceeded",
      // The one reason the database accepts, with the situation that produced
      // it written alongside: two rounds failing on the same check is not the
      // same problem as a budget running out while progress was real.
      convergence: "stalled",
    });
    const stopped = JSON.parse(String((await client.execute(
      "SELECT data FROM event_log WHERE type = 'story.stopped' ORDER BY id DESC LIMIT 1",
    )).rows[0]?.data)) as { reason: string; convergence: string };
    expect(stopped).toMatchObject({ reason: "verify_loop_exceeded", convergence: "stalled" });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      state: "NEEDS_INPUT",
      stopReason: "verify_loop_exceeded",
    });
  });

  async function spendInnerLoop(): Promise<void> {
    // One real round freezes the DoD through SHAPE; the remaining rounds of the
    // budget are recorded directly, as a long inner loop would have left them.
    const first = new SingleStoryWorker(store, {
      run: async (input: ManagedPhaseInput) => frontPhase(input)
        ?? { sessionId: "session-code-1", artifacts: [{ kind: "implementation", body: "First" }] },
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
      stopReason: "retry_limit_exceeded",
    });
  });

  it("grants a fresh inner loop after a person acted on the card, numbering rounds onward", async () => {
    await spendInnerLoop();
    await client.execute("UPDATE stories SET last_human_action_at = 9000000000000 WHERE id = 'S-EPIC1-01'");
    const seenRounds: number[] = [];
    const phases = {
      run: async (input: ManagedPhaseInput) => {
        seenRounds.push(input.round);
        return frontPhase(input) ?? {
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
      run: async (input: ManagedPhaseInput) => frontPhase(input) ?? {
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

describe("SingleStoryWorker SHAPE re-entry after a crash", () => {
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

  it("reuses the frozen Definition of Done instead of burning SHAPE sessions against it", async () => {
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    await store.beginPhase({ runId: "run-shape", cardId: "S-EPIC1-01", phase: "SHAPE", round: 1, prompt: "shape" });
    await store.completePhase({
      runId: "run-shape",
      sessionId: "session-shape",
      artifacts: [{ kind: "dod", body: DOD }, { kind: "open-questions", body: "[]" }],
    });
    // The crash lands here: the setpoint is frozen but the Story never left SHAPE.
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(DOD));

    const phases = vi.fn(async (input: ManagedPhaseInput) => frontPhase(input) ?? (input.phase === "CODE"
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
    expect(phases.mock.calls.map(([input]) => input.phase)).not.toContain("SHAPE");
    const artifacts = await client.execute(
      "SELECT kind FROM phase_artifacts WHERE card_id = 'S-EPIC1-01' AND phase = 'SHAPE' ORDER BY kind",
    );
    expect(artifacts.rows).toMatchObject([{ kind: "dod" }, { kind: "open-questions" }]);
  });

  it("sends an English DoD back to the same SHAPE session, because a person has to read it", async () => {
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    const english = DOD
      .replace("design_summary: 每个阶段的产出都存在中央库里，下一个阶段开始时能读到上一个阶段留下的东西。", "design_summary: Persist every phase output centrally.")
      .replace("    title: 上一阶段的产出还在\n", "")
      .replace("    given: 一个阶段已经做完", "    given: A completed phase");
    let shaped = 0;
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "SHAPE") {
        shaped++;
        return frontPhase(input, shaped === 1 ? english : DOD)!;
      }
      const front = frontPhase(input);
      if (front) return front;
      if (input.phase === "CODE") return { sessionId: `session-code-${input.round}`, artifacts: [{ kind: "implementation", body: "done" }] };
      return { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "两个场景都通过了。" }] };
    });
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({ sessionId: `session-verify-${input.round}`, verdict: "accepted" as const, failedScenarios: [], artifact: "{}" })),
    };
    const friction = { record: vi.fn(async () => undefined) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) }, { enqueue: vi.fn(async () => undefined) }, { friction });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(shaped).toBe(2);
    // Counted, so the rule can be judged on how often it actually fires.
    expect(friction.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "dod_language_rejected" }));
    const frozen = await store.getDefinitionOfDone("S-EPIC1-01");
    expect(frozen.scenarios[0]?.title).toBe("上一阶段的产出还在");
    const titles = await client.execute("SELECT title FROM story_specs WHERE story_id = 'S-EPIC1-01' ORDER BY seq");
    expect(titles.rows.map((row) => row.title)).toEqual(["上一阶段的产出还在", "打回后问题变少"]);
  });

  it("hands a screen scenario with no page back to the session that wrote it", async () => {
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    const screens = withScreens(DOD);
    const pageless = screens.replace("    page: /tasks\n", "");
    let shaped = 0;
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "SHAPE") {
        shaped++;
        return frontPhase(input, shaped === 1 ? pageless : screens)!;
      }
      const front = frontPhase(input);
      if (front) return front;
      if (input.phase === "CODE") return { sessionId: `session-code-${input.round}`, artifacts: [{ kind: "implementation", body: "done" }] };
      return { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "两个场景都通过了。" }] };
    });
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({ sessionId: `session-verify-${input.round}`, verdict: "accepted" as const, failedScenarios: [], artifact: "{}" })),
    };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) }, { enqueue: vi.fn(async () => undefined) });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(shaped).toBe(2);
    const frozen = await store.getDefinitionOfDone("S-EPIC1-01");
    expect(frozen.scenarios[0]?.page).toBe("/tasks");
  });

  it("hands a footprint the repository has no room for back to the session that wrote it", async () => {
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    const ungrounded = DOD.replace("predicted_footprint: [src/orchestrator]", "predicted_footprint: [orchestrator/]");
    let shaped = 0;
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "SHAPE") {
        shaped++;
        return frontPhase(input, shaped === 1 ? ungrounded : DOD)!;
      }
      const front = frontPhase(input);
      if (front) return front;
      if (input.phase === "CODE") return { sessionId: `session-code-${input.round}`, artifacts: [{ kind: "implementation", body: "done" }] };
      return { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "两个场景都通过了。" }] };
    });
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({ sessionId: `session-verify-${input.round}`, verdict: "accepted" as const, failedScenarios: [], artifact: "{}" })),
    };
    const friction = { record: vi.fn(async () => undefined) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) }, { enqueue: vi.fn(async () => undefined) },
      { friction, repositoryHas: (path) => path === "src" || path === "src/orchestrator" });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(shaped).toBe(2);
    expect(friction.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: "footprint_without_ground",
      detail: "orchestrator/",
    }));
    const frozen = await store.getDefinitionOfDone("S-EPIC1-01");
    expect(frozen.predicted_footprint).toEqual(["src/orchestrator"]);
  });

  it("sends a screen the application does not serve back to the session that wrote it", async () => {
    let mounted = false;
    const reachable = vi.fn(async (pages: readonly { scenarioId: string; page: string }[]) =>
      mounted ? [] : pages.map((entry) => ({ ...entry, reason: "应用回了「找不到页面」（HTTP 404）" })));
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "SHAPE") return frontPhase(input, withScreens(DOD))!;
      const front = frontPhase(input);
      if (front) return front;
      if (input.phase === "CODE") {
        const gate = input.exitGates!.find((candidate) => candidate.name === "screen-reachable")!;
        const refused = await gate.evaluate([{ kind: "implementation", body: "done" }], 1);
        expect(refused).toMatchObject({ passed: false, findings: expect.stringContaining("/tasks") });
        // The same session mounts it and is asked again.
        mounted = true;
        expect(await gate.evaluate([{ kind: "implementation", body: "done" }], 2)).toEqual({ passed: true });
        return {
          sessionId: `session-code-${input.round}`,
          artifacts: [{ kind: "implementation", body: "done" }],
          exitGateRounds: { "screen-reachable": 2 },
        };
      }
      return { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "两个场景都通过了。" }] };
    });
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({ sessionId: `session-verify-${input.round}`, verdict: "accepted" as const, failedScenarios: [], artifact: "{}" })),
    };
    const friction = { record: vi.fn(async () => undefined) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) }, { enqueue: vi.fn(async () => undefined) },
      { friction, screensReachable: reachable });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    // One CODE run: the handback happened inside it and cost no round.
    expect(phases.mock.calls.filter(([input]) => input.phase === "CODE")).toHaveLength(1);
    expect(reachable).toHaveBeenCalledWith([{ scenarioId: "S-EPIC1-01-a", page: "/tasks" }]);
    expect(friction.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "screen_not_mounted" }));
  });

  it("asks nothing of a repository that declares no way to start an application", async () => {
    const reachable = vi.fn(async () => null);
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "SHAPE") return frontPhase(input, withScreens(DOD))!;
      const front = frontPhase(input);
      if (front) return front;
      if (input.phase === "CODE") {
        const gate = input.exitGates!.find((candidate) => candidate.name === "screen-reachable")!;
        expect(await gate.evaluate([{ kind: "implementation", body: "done" }], 1)).toEqual({ passed: true });
        return { sessionId: `session-code-${input.round}`, artifacts: [{ kind: "implementation", body: "done" }] };
      }
      return { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "两个场景都通过了。" }] };
    });
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({ sessionId: `session-verify-${input.round}`, verdict: "accepted" as const, failedScenarios: [], artifact: "{}" })),
    };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) }, { enqueue: vi.fn(async () => undefined) },
      { screensReachable: reachable });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(reachable).toHaveBeenCalledTimes(1);
  });

  it("hands back a contract that does not parse instead of throwing out of the phase", async () => {
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "SPECIFY") {
        const gate = input.exitGates!.find((candidate) => candidate.name === "specify-exit")!;
        // What the model actually wrote: the contract plus one key the schema
        // does not have. Thrown, this left the process and cost a re-entry.
        const refused = await gate.evaluate(
          [{ kind: "test-contract", body: `${TEST_CONTRACT}\nobservations: []\n` }],
          1,
        );
        expect(refused).toMatchObject({ passed: false, findings: expect.stringContaining("observations") });
        return {
          sessionId: "session-specify",
          artifacts: [{ kind: "test-contract", body: TEST_CONTRACT }],
          exitGateRounds: { "specify-exit": 2 },
        };
      }
      const front = frontPhase(input);
      if (front) return front;
      if (input.phase === "CODE") return { sessionId: `session-code-${input.round}`, artifacts: [{ kind: "implementation", body: "done" }] };
      return { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "Both scenarios passed." }] };
    });
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({ sessionId: `session-verify-${input.round}`, verdict: "accepted" as const, failedScenarios: [], artifact: "{}" })),
    };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) }, { enqueue: vi.fn(async () => undefined) });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(phases.mock.calls.filter(([input]) => input.phase === "SPECIFY")).toHaveLength(1);
  });

  it("lets the SPECIFY session correct a contract the exit refuses, without spending a phase run", async () => {
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      if (input.phase === "SPECIFY") {
        const gate = input.exitGates!.find((candidate) => candidate.name === "specify-exit")!;
        const refused = await gate.evaluate([{ kind: "test-contract", body: NARROW_CONTRACT }], 1);
        expect(refused).toMatchObject({ passed: false, findings: expect.stringContaining("must be full") });
        return {
          sessionId: "session-specify",
          artifacts: [{ kind: "test-contract", body: TEST_CONTRACT }],
          exitGateRounds: { "specify-exit": 2 },
        };
      }
      const front = frontPhase(input);
      if (front) return front;
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
    // One SPECIFY run, and nothing invalidated: the refusal was a work item
    // inside the session, not a verdict on the phase.
    expect(phases.mock.calls.filter(([input]) => input.phase === "SPECIFY")).toHaveLength(1);
    expect(friction.record).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "specify_exit_rejected" }));
    const invalidated = await client.execute(
      "SELECT count(*) AS n FROM event_log WHERE card_id = 'S-EPIC1-01' AND type = 'phase.invalidated'",
    );
    expect(Number(invalidated.rows[0]!.n)).toBe(0);
  });

  it("fails the SPECIFY phase when the contract is still wrong after the session has had its rounds", async () => {
    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      // A port that does not enforce the gate: the worker has to judge what
      // came back on its own.
      if (input.phase === "SPECIFY") {
        return { sessionId: "session-specify", artifacts: [{ kind: "test-contract", body: NARROW_CONTRACT }] };
      }
      return frontPhase(input) ?? { sessionId: "session-code", artifacts: [{ kind: "implementation", body: "done" }] };
    });
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({ sessionId: `session-verify-${input.round}`, verdict: "accepted" as const, failedScenarios: [], artifact: "{}" })),
    };
    const friction = { record: vi.fn(async () => undefined) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier,
      { deliver: vi.fn(async () => ({ mrUrl: null })) }, { enqueue: vi.fn(async () => undefined) }, { friction });

    await expect(worker.run("S-EPIC1-01")).rejects.toThrow(/must be full/);
    expect(friction.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "specify_exit_rejected" }));
    const invalidated = await client.execute(
      "SELECT count(*) AS n FROM event_log WHERE card_id = 'S-EPIC1-01' AND type = 'phase.invalidated'",
    );
    expect(Number(invalidated.rows[0]!.n)).toBe(1);
  });

  it("shapes a CODE Story again when its frozen DoD no longer satisfies the contract", async () => {
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    await store.beginPhase({ runId: "run-shape", cardId: "S-EPIC1-01", phase: "SHAPE", round: 1, prompt: "shape" });
    // A DoD frozen under an older contract: no examples, no source, no criteria.
    const stale = "story_id: S-EPIC1-01\nscenarios:\n  - id: S-EPIC1-01-old\n    given: a\n    when: b\n    then: c\n    layer: ui\n";
    await store.completePhase({
      runId: "run-shape",
      sessionId: "session-shape",
      artifacts: [{ kind: "dod", body: stale }, { kind: "open-questions", body: "[]" }],
    });
    await client.execute("INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES ('S-EPIC1-01-old','S-EPIC1-01',1,'old','pending')");
    await store.transition("S-EPIC1-01", "SHAPE", "DESIGN", "system", "run-shape");
    await store.transition("S-EPIC1-01", "DESIGN", "SPECIFY", "system", "run-design");
    await store.transition("S-EPIC1-01", "SPECIFY", "CODE", "system", "run-specify");

    const phases = vi.fn(async (input: ManagedPhaseInput) => {
      const front = frontPhase(input);
      if (front) return front;
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
    expect(phases.mock.calls.map(([input]) => input.phase)).toEqual(["SHAPE", "DESIGN", "SPECIFY", "CODE", "MERGE"]);
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
      const front = frontPhase(input);
      if (front) return front;
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

  it("counts a rebase conflict, with the ground the two Stories wanted", async () => {
    const { phases, verifier, delivery, projection } = ports();
    const integration = {
      integrate: vi.fn(async () => ({
        kind: "conflict",
        reason: "CONFLICT in src/a",
        integrationBranch: "epic/EPIC1",
        files: ["src/a/one.ts", "src/a/two.ts"],
      })),
    };
    const recorded: Array<{ kind: string; detail: string }> = [];
    const friction = { record: async (input: { kind: string; detail: string }) => { recorded.push(input); } };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration, friction });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "CODE" });
    expect(recorded).toMatchObject([{ kind: "merge_conflict" }]);
    expect(JSON.parse(recorded[0]!.detail)).toEqual({
      branch: "epic/EPIC1",
      files: ["src/a/one.ts", "src/a/two.ts"],
    });
  });

  it("spends a round on a merge its own work broke, and stops on the budget", async () => {
    const { phases, verifier, delivery, projection } = ports();
    const integration = {
      integrate: vi.fn(async (cardId: string, runId: string) => {
        await store.recordIntegrationRejection(cardId, runId, "npm test fails with this Story on top", {
          attribution: "story_regression", failures: ["src/coupon.test.ts > applies the discount"],
        });
        return {
          kind: "verification_failed",
          reason: "npm test fails with this Story on top",
          attribution: "story_regression" as const,
          failures: ["src/coupon.test.ts > applies the discount"],
        };
      }),
    };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, {
      integration, maxInnerLoopRounds: 1, runId: (_cardId, phase, round) => `run-${phase}-${round}`,
    });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({
      state: "NEEDS_INPUT", stopReason: "retry_limit_exceeded",
    });
    const stopped = JSON.parse(String((await client.execute(
      "SELECT data FROM event_log WHERE type = 'story.stopped' ORDER BY id DESC LIMIT 1",
    )).rows[0]?.data)) as Record<string, unknown>;
    expect(stopped).toMatchObject({
      reason: "retry_limit_exceeded",
      convergence: "budget_exhausted",
      mergeBounce: "story_regression",
      failures: ["src/coupon.test.ts > applies the discount"],
    });
  });

  it("charges nothing for a merge the Epic head was already failing", async () => {
    const { phases, verifier, delivery, projection } = ports();
    const integration = {
      integrate: vi.fn(async (cardId: string, runId: string) => {
        await store.recordBaselineFailure({
          cardId,
          runId,
          check: "npm test",
          failures: ["src/runner/catalog-snapshot.test.ts > deepseek"],
          headSha: "beef2",
          reason: "npm test fails on the Epic head without this Story",
        });
        return {
          kind: "verification_failed",
          reason: "npm test fails on the Epic head without this Story",
          attribution: "baseline_failing" as const,
        };
      }),
    };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, {
      integration, maxInnerLoopRounds: 1,
    });

    // The same failure that stops the card above leaves it alone here: no
    // amount of work on this Story turns the Epic head green, so it waits in
    // MERGE rather than buying CODE turns.
    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "MERGE", stopReason: null });
    await expect(store.getInnerLoopSpend("S-EPIC1-01")).resolves.toBe(0);
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({ state: "MERGE" });
  });

  it("hands a check that never ran to the crash safety net instead of the card", async () => {
    const { phases, verifier, delivery, projection } = ports();
    const integration = {
      integrate: vi.fn(async () => ({
        kind: "verification_failed",
        reason: "npm test could not be run: spawn npm ENOENT",
        attribution: "environment" as const,
      })),
    };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, {
      integration, maxInnerLoopRounds: 1,
    });

    await expect(worker.run("S-EPIC1-01")).rejects.toThrow(/could not be re-verified at merge/);
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
  const phases = vi.fn(async (input: ManagedPhaseInput) => (input.phase === "SPECIFY"
    ? { sessionId: "session-narrow", artifacts: [{ kind: "test-contract", body: NARROW_CONTRACT }] }
    : { sessionId: `session-fix-${input.round}`, artifacts: [{ kind: "implementation", body: "fixed" }] }));
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
    await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
    await store.beginPhase({ runId: "run-shape", cardId: "S-EPIC1-01", phase: "SHAPE", round: 1, prompt: "shape" });
    await store.completePhase({ runId: "run-shape", sessionId: "s-shape", artifacts: [{ kind: "dod", body: DOD }] });
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(DOD));
    await client.execute("UPDATE stories SET state = 'DELIVERED', phase = NULL, inner_loop_rounds = 3, mr_url = 'https://example.test/pull/1' WHERE id = 'S-EPIC1-01'");
    // Exactly what the attribution runner writes: the card reenters at the
    // narrow SPECIFY, its phase naming where that SPECIFY leads.
    await client.execute("UPDATE stories SET state = 'SPECIFY', phase = 'REGRESSION_FIX' WHERE id = 'S-EPIC1-01'");
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
    expect(phases.mock.calls[0]![0].phase).toBe("SPECIFY");
    const [input] = phases.mock.calls[1]!;
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
    // The narrow SPECIFY ran; the fix itself never did.
    expect(phases.mock.calls.map(([input]) => input.phase)).toEqual(["SPECIFY"]);
    expect(await store.getStory("S-EPIC1-01")).toMatchObject({ stopReason: "retry_limit_exceeded" });
  });

  it("leaves through MERGE when nothing is left to fix, because the work may never have landed", async () => {
    // S-R237511MB-02 reached DELIVERED from here with 29 commits still ahead
    // of its Epic head: the round that reopened it stopped before the fix
    // landed, and "no cards left" was read as "delivered".
    const { phases, verifier, integration, delivery, projection } = regressionPorts(true);
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "MERGE" });
    expect(await store.getStory("S-EPIC1-01")).toMatchObject({ state: "MERGE" });
    expect(phases).not.toHaveBeenCalled();
  });

  it("still delivers when there is no Epic to land on", async () => {
    const { phases, verifier, delivery, projection } = regressionPorts(true);
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, {});

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(phases).not.toHaveBeenCalled();
  });

  it("re-verifies a reopened scenario the environment could not judge, buying no second fix", async () => {
    // S-R237511MB-02 was reopened for a scenario judged from outside the
    // allowed networks. Going back around the loop bought a REGRESSION_FIX
    // turn, and that turn answered the unreachable premise by rendering the
    // denial page to every caller.
    await openCard();
    const outcomes = [
      { verdict: "inconclusive" as const, failedScenarios: ["S-EPIC1-01-a"] },
      { verdict: "accepted" as const, failedScenarios: [] },
    ];
    let attempt = 0;
    const { phases, integration, delivery, projection } = regressionPorts(true);
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => {
        const outcome = outcomes[attempt++]!;
        return { sessionId: `session-verify-${input.round}`, artifact: JSON.stringify(outcome), ...outcome };
      }),
    };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    expect(phases.mock.calls.map(([input]) => input.phase)).toEqual(["SPECIFY", "REGRESSION_FIX"]);
    expect(verifier.run).toHaveBeenCalledTimes(2);
    // Both attempts judged the same fix, so the tree the retry is compared
    // against is the tree that was already there.
    const sessions = new Set((verifier.run as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => (input as { codeSessionId: string }).codeSessionId));
    expect(sessions.size).toBe(1);
  });

  it("stops for a person when the environment loses the reopened scenario twice, and says which", async () => {
    await openCard();
    const { phases, integration, delivery, projection } = regressionPorts(true);
    const verifier: StoryVerifyPort = {
      run: vi.fn(async (input) => ({
        sessionId: `session-verify-${input.round}`,
        artifact: "{}",
        verdict: "inconclusive" as const,
        failedScenarios: ["S-EPIC1-01-a"],
      })),
    };
    const friction = { record: vi.fn(async () => undefined) };
    const worker = new SingleStoryWorker(store, { run: phases }, verifier, delivery, projection, { integration, friction });

    await expect(worker.run("S-EPIC1-01")).resolves.toMatchObject({
      state: "NEEDS_INPUT", stopReason: "verify_loop_exceeded",
    });
    expect(phases.mock.calls.map(([input]) => input.phase)).toEqual(["SPECIFY", "REGRESSION_FIX"]);
    expect(friction.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "verification_inconclusive" }));
    const summary = JSON.parse(String((await client.execute(
      "SELECT stop_summary FROM stories WHERE id = 'S-EPIC1-01'",
    )).rows[0]?.stop_summary));
    expect(summary.inconclusive).toMatchObject({ attempts: 2, scenarios: ["S-EPIC1-01-a"] });
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
    expect(phases.mock.calls.map(([input]) => input.phase)).toEqual(["SPECIFY", "REGRESSION_FIX", "REGRESSION_FIX"]);
    expect(phases.mock.calls[2]![0].prompt).toContain("the checks failed with this Story on top of the Epic head");
  });
});


describe("SingleStoryWorker scenario carry-forward", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;
  /** The worktree's tree sha, which the tests move to stand for a code change. */
  let tree: string;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    tree = "tree-1";
    store = new StoryExecutionStore(client, (() => { let time = 1_000; return () => time++; })());
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Carry a conclusion forward",
      requirement: "A scenario nobody touched is not verified twice.",
      repo: "xiayu1996/hivemind",
      branch: "story/epic1-01",
    });
  });

  afterEach(() => client.close());

  function worker(
    phases: (input: ManagedPhaseInput) => Promise<{ sessionId: string; artifacts: Array<{ kind: string; body: string }> }>,
    verifier: StoryVerifyPort,
  ): SingleStoryWorker {
    return new SingleStoryWorker(
      store,
      { run: phases },
      verifier,
      { deliver: async () => ({ mrUrl: null }) },
      { enqueue: async () => undefined },
      { treeSha: async () => tree },
    );
  }

  const passing: StoryVerifyPort = {
    run: async (input) => ({
      sessionId: `session-verify-${input.round}`,
      verdict: "accepted",
      failedScenarios: [],
      artifact: "{}",
    }),
  };

  const build = async (input: ManagedPhaseInput) => frontPhase(input) ?? (input.phase === "CODE"
    ? { sessionId: `session-code-${input.round}`, artifacts: [{ kind: "implementation", body: "done" }] }
    : { sessionId: "session-merge", artifacts: [{ kind: "delivery-report", body: "Both scenarios passed." }] });

  it("records a conclusion per scenario against the contract wording and the tree it was reached on", async () => {
    await expect(worker(build, passing).run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    const rows = (await client.execute(
      "SELECT scenario_id, outcome, verified_tree_sha FROM verify_scenario_results ORDER BY scenario_id",
    )).rows;
    expect(rows).toMatchObject([
      { scenario_id: "S-EPIC1-01-a", outcome: "passed", verified_tree_sha: "tree-1" },
      { scenario_id: "S-EPIC1-01-b", outcome: "passed", verified_tree_sha: "tree-1" },
    ]);
  });

  it("reuses the untouched scenario's conclusion when only the other scenario's wording changed", async () => {
    await expect(worker(build, passing).run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });

    // A person reworded scenario a. Its own conclusion is void; b's is not.
    const reworded = parseDoD(DOD.replace(
      "then: 它能读到上一阶段留下的产出",
      "then: 它能一字不差地读到上一阶段留下的产出",
    ));
    await store.refreezeDefinitionOfDone("S-EPIC1-01", reworded);
    const versions = await store.definitionVersions("S-EPIC1-01");
    const before = await store.scenarioConclusions("S-EPIC1-01");
    expect(before.get("S-EPIC1-01-a")?.scenarioVersion).not.toBe(versions.scenarios.get("S-EPIC1-01-a"));
    expect(before.get("S-EPIC1-01-b")?.scenarioVersion).toBe(versions.scenarios.get("S-EPIC1-01-b"));

    // Verifying only a, on the same tree, is enough to settle the card again.
    const narrowed = { ...reworded, scenarios: reworded.scenarios.filter((entry) => entry.id === "S-EPIC1-01-a") };
    await store.recordVerification("rerun-a", {
      cardId: "S-EPIC1-01",
      round: 9,
      codeSessionId: "code-9",
      verifySessionId: "verify-9",
      verdict: "accepted",
      failedScenarios: [],
      verifiedScenarios: narrowed.scenarios.map((entry) => entry.id),
      verifiedTreeSha: tree,
    });
    const carried = await store.carryForwardScenarios({ cardId: "S-EPIC1-01", round: 9, treeSha: tree });
    expect(carried).toEqual({ carried: ["S-EPIC1-01-b"], stale: [] });
    await expect(store.scenariosSettled("S-EPIC1-01", tree)).resolves.toEqual({ ready: true, outstanding: [] });
  });

  it("refuses to carry anything onto a tree that moved, however small the change was", async () => {
    await expect(worker(build, passing).run("S-EPIC1-01")).resolves.toMatchObject({ state: "DELIVERED" });
    tree = "tree-2";
    const carried = await store.carryForwardScenarios({ cardId: "S-EPIC1-01", round: 9, treeSha: tree });
    expect(carried).toEqual({ carried: [], stale: ["S-EPIC1-01-a", "S-EPIC1-01-b"] });
    await expect(store.scenariosSettled("S-EPIC1-01", tree)).resolves.toMatchObject({
      ready: false,
      outstanding: ["S-EPIC1-01-a", "S-EPIC1-01-b"],
    });
  });

  it("verifies again instead of merging when a scenario was reworded after the verdict", async () => {
    const verified: number[] = [];
    let reworded = false;
    const delivered: string[] = [];
    const result = await new SingleStoryWorker(
      store,
      { run: build },
      {
        run: async (input) => {
          verified.push(input.round);
          return { sessionId: `session-verify-${input.round}`, verdict: "accepted", failedScenarios: [], artifact: "{}" };
        },
      },
      { deliver: async () => { delivered.push("delivered"); return { mrUrl: null }; } },
      {
        // The projection runs after the verdict is recorded, which is where a
        // person rewording a scenario lands: the round that was just accepted
        // no longer covers the card.
        enqueue: async () => {
          if (reworded || verified.length === 0) return;
          reworded = true;
          await store.refreezeDefinitionOfDone("S-EPIC1-01", parseDoD(DOD.replace(
            "then: 没通过的场景比上一轮更少",
            "then: 没通过的场景每一轮都比上一轮更少",
          )));
        },
      },
      { treeSha: async () => tree, maxInnerLoopRounds: 3 },
    ).run("S-EPIC1-01");

    // The accepted first round did not deliver: one of the two scenarios was no
    // longer the scenario that verdict was about.
    expect(verified).toEqual([1, 2]);
    expect(result).toMatchObject({ state: "DELIVERED" });
    expect(delivered).toEqual(["delivered"]);
  });
});
