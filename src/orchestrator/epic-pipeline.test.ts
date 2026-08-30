// oxlint-disable unicorn/no-thenable -- the scenario grammar names a "then" field
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { attributeCard, attributionSequence } from "../regression/attribution-runner.js";
import { planRegressionSweep } from "../regression/scheduler.js";
import { ScenarioRegistry } from "../regression/scenario-registry.js";
import { RegressionStore } from "../regression/store.js";
import { RegressionSweeper } from "../regression/sweeper.js";
import { EpicDecomposer } from "./decompose-runner.js";
import { EpicIntegrator } from "./epic-integration.js";
import { IntegrationDispatchStore } from "./integration-dispatch.js";
import { PlanApprovalStore } from "./plan-approval.js";
import { dispatchableStories, planStoryExecution } from "./scheduler.js";
import { StoryExecutionStore } from "./story-execution-store.js";

const PLAN = {
  epicId: "M2",
  businessGoal: "客户在一次评审里看到整个提案的结果。",
  stories: [
    {
      id: "S-M2-01",
      title: "客户看到提案概要",
      requirement: "客户打开提案时先看到整体结论。",
      scenarios: [{ id: "S-M2-01-a", given: "客户收到提案", when: "客户打开提案", then: "客户先看到整体结论" }],
      dependsOn: [],
      predictedFootprint: ["src/summary"],
    },
    {
      id: "S-M2-02",
      title: "客户看到逐项明细",
      requirement: "客户展开提案后看到每一项的结果。",
      scenarios: [{ id: "S-M2-02-a", given: "客户看到概要", when: "客户展开提案", then: "客户看到每一项结果" }],
      dependsOn: [],
      predictedFootprint: ["src/detail"],
    },
    {
      id: "S-M2-03",
      title: "客户导出提案",
      requirement: "客户把提案结果交给同事时不丢失任何一项。",
      scenarios: [{ id: "S-M2-03-a", given: "客户看到明细", when: "客户导出提案", then: "同事收到完整结果" }],
      dependsOn: ["S-M2-01", "S-M2-02"],
      predictedFootprint: ["src/export"],
    },
  ],
};

const POLICY = { windowSize: 10, failureRateThreshold: 0.5, minFailures: 2 };

describe("M2 acceptance: one Epic from decomposition to review request", () => {
  let client: ReturnType<typeof createClient>;
  let store: StoryExecutionStore;
  let approvals: PlanApprovalStore;
  let registry: ScenarioRegistry;
  let time: number;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    time = 1_000;
    store = new StoryExecutionStore(client, () => time++);
    approvals = new PlanApprovalStore(client, () => time++);
    registry = new ScenarioRegistry(client, () => time);
    await client.execute(
      "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2','epic-page','M2 并行与回归','INTAKE',1,1)",
    );
  });

  afterEach(() => client.close());

  /** Freezes the DoD the way DESIGN would, so the scenarios exist to verify. */
  async function design(storyId: string): Promise<void> {
    const story = PLAN.stories.find((candidate) => candidate.id === storyId)!;
    await client.batch(story.scenarios.map((scenario, index) => ({
      sql: "INSERT INTO story_specs (spec_id, story_id, seq, text, status) VALUES (?, ?, ?, ?, 'pending')",
      args: [scenario.id, storyId, index + 1, `Given ${scenario.given}; when ${scenario.when}; then ${scenario.then}`],
    })), "write");
    await registry.registerStory(storyId);
  }

  async function reachMerge(storyId: string): Promise<void> {
    // The cut is delayed until the dependencies are on the head, which is what
    // claimStart enforces; the branch does not exist before that.
    const claim = await new IntegrationDispatchStore(client).claimStart(storyId, `story/${storyId.toLowerCase()}`);
    expect(claim).toMatchObject({ kind: "started", integrationBranch: "epic/M2" });
    for (const [from, to] of [["QUEUED", "DESIGN"], ["DESIGN", "CODE"], ["CODE", "VERIFY"], ["VERIFY", "MERGE"]] as const) {
      await store.transition(storyId, from, to, "system", `${storyId}-${to}`);
    }
  }

  async function integrate(storyId: string, revision: string, base: string): Promise<void> {
    await client.execute({
      sql: `INSERT INTO actual_footprint_captures
              (story_id, integration_branch, base_revision, story_revision, actual_footprint, state, created_at, applied_at)
            VALUES (?, 'epic/M2', ?, ?, '[]', 'applied', ?, ?)`,
      args: [storyId, base, revision, time, time],
    });
    const flow = { merge: vi.fn(async () => ({ kind: "merged" as const, integrationBranch: "epic/M2", scenarioIds: [] })) };
    await new EpicIntegrator(client, store, flow).integrate(storyId, `${storyId}-merge`);
    await store.transition(storyId, "MERGE", "DELIVERED", "system", `${storyId}-delivered`);
    await registry.promoteToMain(storyId);
  }

  it("splits, waits for a human, runs what can run together, and lands each Story on the Epic head", async () => {
    // 1. Decomposition reaches the approval gate and nothing executes yet.
    const decomposer = new EpicDecomposer(client, approvals, { run: async () => PLAN }, () => time++);
    await expect(decomposer.decompose({
      id: "M2",
      notionPageId: "epic-page",
      title: "M2 并行与回归",
      requirement: "多个 Story 并行推进并合成一次评审。",
    })).resolves.toMatchObject({ kind: "presented", stories: 3 });

    expect((await client.execute("SELECT state FROM epics WHERE id = 'M2'")).rows[0]?.state).toBe("PLAN_APPROVAL");
    expect((await client.execute("SELECT COUNT(*) AS count FROM stories")).rows[0]?.count).toBe(0);
    expect((await client.execute("SELECT operation FROM notion_outbox")).rows)
      .toMatchObject([{ operation: "present_epic_plan" }]);

    // 2. A human approves; the Stories appear, still unstarted.
    await expect(approvals.approve({ epicId: "M2", eventId: "drag-1", source: "drag" })).resolves.toBe(true);
    expect((await client.execute("SELECT state FROM epics WHERE id = 'M2'")).rows[0]?.state).toBe("EXECUTING");
    const stories = (await client.execute("SELECT id, state FROM stories ORDER BY id")).rows;
    expect(stories).toMatchObject([
      { id: "S-M2-01", state: "QUEUED" },
      { id: "S-M2-02", state: "QUEUED" },
      { id: "S-M2-03", state: "QUEUED" },
    ]);

    // 3. The scheduler runs the two independent Stories together and holds the
    //    dependent one back, which is the whole point of the footprint plan.
    const rows = (await client.execute("SELECT id, state, depends_on, predicted_footprint FROM stories")).rows;
    const plan = planStoryExecution(dispatchableStories(rows.map((row) => ({
      id: String(row.id),
      state: String(row.state),
      dependsOn: JSON.parse(String(row.depends_on)) as string[],
      predictedFootprint: JSON.parse(String(row.predicted_footprint)) as string[],
    }))), []);
    expect(plan).toEqual({ kind: "planned", batches: [["S-M2-01", "S-M2-02"], ["S-M2-03"]] });

    // 4. Each Story lands on the Epic head, in the order the plan allowed.
    for (const [index, storyId] of ["S-M2-01", "S-M2-02", "S-M2-03"].entries()) {
      await design(storyId);
      await reachMerge(storyId);
      await integrate(storyId, `rev-${index + 1}`, index === 0 ? "rev-base" : `rev-${index}`);
    }
    const dispatches = (await client.execute("SELECT state FROM execution_dispatches")).rows;
    expect(dispatches.every((row) => row.state === "integrated")).toBe(true);
    expect((await client.execute("SELECT integration_branch FROM epics WHERE id = 'M2'")).rows[0]?.integration_branch)
      .toBe("epic/M2");

    // 5. Every Story delivered means the Epic has one review request to open.
    const outstanding = (await client.execute(
      `SELECT COUNT(*) AS count FROM stories s LEFT JOIN execution_dispatches d ON d.story_id = s.id
        WHERE s.epic_id = 'M2' AND (s.state <> 'DELIVERED' OR d.state IS NOT 'integrated')`,
    )).rows[0];
    expect(outstanding?.count).toBe(0);

    // 6. The resident loop finds every scenario due, because integration cleared
    //    what the previous head had verified.
    const sweep = planRegressionSweep({
      now: 2_000_000,
      foregroundBusy: false,
      epicScenarios: await registry.pool("epic"),
      mainScenarios: await registry.pool("main"),
      policy: { epicPoolIntervalMs: 900_000, mainPoolIntervalMs: 86_400_000, batchSize: 5 },
    });
    expect(sweep).toMatchObject({ pool: "main", reason: "idle" });
    expect(sweep?.scenarioIds).toEqual(["S-M2-01-a", "S-M2-02-a", "S-M2-03-a"]);

    // 7. A regression introduced by the second Story is raised once it
    //    reproduces, bisected to that Story, and that Story alone reopens.
    const regressions = new RegressionStore(client, () => time++);
    const broken = { run: vi.fn(async () => ({
      revision: "rev-3",
      outcomes: [{ scenarioId: "S-M2-01-a", outcome: "failed" as const, output: "TypeError: summary is not iterable" }],
    })) };
    const sweeper = new RegressionSweeper(registry, regressions, broken);
    const request = { pool: "main" as const, branch: "main", scenarioIds: ["S-M2-01-a"] };
    await expect(sweeper.sweep(request, POLICY)).resolves.toMatchObject({ raised: [] });
    const second = await sweeper.sweep(request, POLICY);
    expect(second.raised).toHaveLength(1);

    const failsFrom = new Set(["rev-2", "rev-3"]);
    const attribution = await attributeCard(
      client,
      regressions,
      { scenarioId: "S-M2-01-a", failureSignature: second.raised[0]!.signature },
      await attributionSequence(client, "M2"),
      async (revision) => failsFrom.has(revision),
      () => time++,
    );

    expect(attribution).toMatchObject({ kind: "introduced", item: "S-M2-02" });
    const afterAttribution = (await client.execute("SELECT id, state, priority FROM stories ORDER BY id")).rows;
    expect(afterAttribution).toMatchObject([
      { id: "S-M2-01", state: "DELIVERED" },
      { id: "S-M2-02", state: "REGRESSION_FIX", priority: 0 },
      { id: "S-M2-03", state: "DELIVERED" },
    ]);
    await expect(regressions.openCards()).resolves.toMatchObject([{ attributedStory: "S-M2-02" }]);
  });

  it("keeps a rejected Story out of the Epic head and off the delivery path", async () => {
    const decomposer = new EpicDecomposer(client, approvals, { run: async () => PLAN }, () => time++);
    await decomposer.decompose({ id: "M2", notionPageId: "epic-page", title: "M2", requirement: "需求" });
    await approvals.approve({ epicId: "M2", eventId: "drag-1", source: "drag" });
    await design("S-M2-01");
    await reachMerge("S-M2-01");

    const flow = { merge: vi.fn(async () => ({
      kind: "verification_failed" as const,
      integrationBranch: "epic/M2",
      scenarioIds: ["S-M2-01-a"],
      reason: "S-M2-01-a fails beside what already landed",
    })) };
    await new EpicIntegrator(client, store, flow).integrate("S-M2-01", "merge-run");

    await expect(store.getStory("S-M2-01")).resolves.toMatchObject({ state: "CODE" });
    expect((await client.execute("SELECT state FROM execution_dispatches WHERE story_id = 'S-M2-01'")).rows[0]?.state)
      .toBe("pending");
  });
});
