import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import type { SolutionCandidate } from "./requirement-solution.js";
import { RequirementStore } from "./requirement-store.js";
import { SolutionRunner, type SolutionPort, type SolutionRequest } from "./solution-runner.js";
import type { PrototypeOutcome, PrototypeRunner } from "./prototype-runner.js";

const REQUIREMENT_ID = "R-abc123def456";

function keepsTheStack(): SolutionCandidate {
  return {
    approach: {
      summary: "沿用仓库现有的服务端与检查方式，只补这条需求要的查询。",
      alternatives: [],
    },
    stackChanges: [],
    openDecisions: [],
    qualityGates: [],
    interface: null,
  };
}

function needsScreens(): SolutionCandidate {
  return {
    ...keepsTheStack(),
    interface: { kind: "web", pages: [{ name: "\u4efb\u52a1\u770b\u677f", purpose: "\u770b\u4eca\u5929\u8981\u505a\u4ec0\u4e48" }] },
  };
}

/** Stands in for the drawing session: the runner only has to decide whether it
 * is asked and what a refusal does. */
function drawing(outcome: PrototypeOutcome) {
  const seen: unknown[] = [];
  return {
    seen,
    runner: { draw: async (input: unknown) => { seen.push(input); return outcome; } } as unknown as PrototypeRunner,
  };
}

function changesTheStack(): SolutionCandidate {
  return {
    approach: {
      summary: "引入一套构建工具来产出页面，其余沿用现有服务端。",
      alternatives: [{ option: "手写静态文件", reason: "每加一页都要重复同样的模板。" }],
    },
    stackChanges: [{
      kind: "added",
      name: "vite",
      reason: "页面需要一个能出构建产物的工具。",
      impact: "package.json, CI build step",
    }],
    qualityGates: [{ name: "ui-build", command: ["npm", "run", "build:ui"], covers: "bundle compiles" }],
    interface: null,
  };
}

class ScriptedPort implements SolutionPort {
  readonly requests: SolutionRequest[] = [];
  constructor(private readonly replies: SolutionCandidate[]) {}

  async run(input: SolutionRequest): Promise<SolutionCandidate> {
    this.requests.push(input);
    const reply = this.replies.shift();
    if (!reply) throw new Error("the solution phase was asked more times than the test scripted");
    return reply;
  }
}

describe("SolutionRunner", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let published: string[];

  function runner(port: SolutionPort, attempts?: number): SolutionRunner {
    return new SolutionRunner(
      store,
      port,
      { publish: async (id: string) => { published.push(id); } },
      attempts === undefined ? {} : { attempts },
    );
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    store = new RequirementStore(client, () => time++);
    published = [];
    await store.createRequirement({
      id: REQUIREMENT_ID,
      notionPageId: "requirement-page",
      title: "给 hivemind 做一个控制台",
      originalRequest: "我想随时知道现在在做什么。",
      repo: "owner/repo",
    });
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-clarified");
    await store.saveDraftPrd(REQUIREMENT_ID, JSON.stringify({
      businessGoal: "值班的人随时看到每张卡进行到哪一步",
      nonGoals: ["这次不做权限"],
      scenarios: [{
        id: `${REQUIREMENT_ID}-s01`,
        given: "值班的人打开看板",
        when: "有一张卡在等人回答",
        // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
        then: "他一眼看到在等谁、等什么",
      }],
      openQuestions: [],
    }), "run-prd");
    await store.confirmPrd(REQUIREMENT_ID, 1, "comment-1", "comment", "run-confirm");
    await store.transition(REQUIREMENT_ID, "PRD_CONFIRM", "SOLUTION", "system", "run-handover");
  });

  afterEach(() => client.close());

  it("lets a solution that decides nothing a person would decide go straight on", async () => {
    const run = runner(new ScriptedPort([keepsTheStack()]));

    await expect(run.advance(REQUIREMENT_ID)).resolves.toEqual({ kind: "confirmed", revision: 1, source: "auto" });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "DECOMPOSING" });
    // Recorded even when nobody read it, so the page can say who let it through.
    await expect(store.getSolution(REQUIREMENT_ID)).resolves.toMatchObject({ status: "confirmed" });
  });

  it("stops for a person when the stack changes, and stays stopped until they say so", async () => {
    const run = runner(new ScriptedPort([changesTheStack()]));

    await expect(run.advance(REQUIREMENT_ID)).resolves.toEqual({
      kind: "drafted", revision: 1, awaiting: ["stack_changes"],
    });
    await expect(run.advance(REQUIREMENT_ID)).resolves.toEqual({ kind: "awaiting", revision: 1 });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "SOLUTION" });

    await store.confirmSolution(REQUIREMENT_ID, 1, "comment-2", "comment", "run-approve");
    await expect(run.advance(REQUIREMENT_ID)).resolves.toEqual({ kind: "confirmed", revision: 1, source: "human" });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "DECOMPOSING" });
  });

  it("stops on a question even when the stack is untouched: a question that auto-approves is unanswered", async () => {
    const run = runner(new ScriptedPort([{
      ...keepsTheStack(),
      openDecisions: [{ question: "手机优先还是电脑优先？", recommendation: "先做手机，电脑用同一套页面。" }],
    }]));

    await expect(run.advance(REQUIREMENT_ID)).resolves.toMatchObject({ awaiting: ["open_decisions"] });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "SOLUTION" });
  });

  it("draws the screens before the approach is read, for a solution that has any", async () => {
    const drawn = drawing({ kind: "drawn", revision: 1, concerns: [], mrUrl: "https://example.invalid/mr/1" });
    const run = new SolutionRunner(
      store,
      new ScriptedPort([needsScreens()]),
      { publish: async (id: string) => { published.push(id); } },
      { prototype: { runner: drawn.runner, contractRoot: async () => "docs/prototype" } },
    );

    await expect(run.advance(REQUIREMENT_ID)).resolves.toMatchObject({ awaiting: ["interface"] });
    expect(drawn.seen).toHaveLength(1);
    expect(drawn.seen[0]).toMatchObject({ revision: 1, contractRoot: "docs/prototype", repository: "owner/repo" });
  });

  it("does not draw anything for a solution with no screens", async () => {
    const drawn = drawing({ kind: "skipped", reason: "no interface" });
    const run = new SolutionRunner(
      store,
      new ScriptedPort([keepsTheStack()]),
      { publish: async (id: string) => { published.push(id); } },
      { prototype: { runner: drawn.runner, contractRoot: async () => "docs/prototype" } },
    );

    await expect(run.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "confirmed" });
    expect(drawn.seen).toEqual([]);
  });

  it("does not send an approach on alone when its screens could not be drawn", async () => {
    const drawn = drawing({ kind: "stopped", reason: "\u754c\u9762\u539f\u578b\u6ca1\u753b\u6210" });
    const run = new SolutionRunner(
      store,
      new ScriptedPort([needsScreens()]),
      { publish: async (id: string) => { published.push(id); } },
      { prototype: { runner: drawn.runner, contractRoot: async () => "docs/prototype" } },
    );

    await expect(run.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "stopped" });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "SOLUTION" });
  });

  it("rewrites once against what the person asked to change", async () => {
    const port = new ScriptedPort([changesTheStack(), changesTheStack()]);
    const run = runner(port);
    await run.advance(REQUIREMENT_ID);

    await expect(store.requestSolutionRevision(
      REQUIREMENT_ID, 1, "不要引入新的构建工具", "comment-3", "comment", "run-revise",
    )).resolves.toBe(true);

    await expect(run.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "drafted", revision: 2 });
    expect(port.requests[1]?.revisionFeedback).toEqual(["不要引入新的构建工具"]);
    expect(port.requests[1]?.repository).toBe("owner/repo");
    await expect(store.getSolution(REQUIREMENT_ID, 1)).resolves.toMatchObject({ status: "superseded" });
  });

  it("rewrites as many times as the configured budget, and no more", async () => {
    const unusable: SolutionCandidate = { approach: { summary: "", alternatives: [] } };
    const port = new ScriptedPort([unusable, unusable, unusable]);

    await expect(runner(port, 3).advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "stopped" });
    expect(port.requests).toHaveLength(3);
    // Each attempt is told what the last one got wrong; starting from the same
    // blank page twice is not a second attempt.
    expect(port.requests[1]?.previousRejections.length).toBeGreaterThan(0);
  });

  it("stops for a person when the solution keeps coming back unusable", async () => {
    const unusable: SolutionCandidate = { approach: { summary: "", alternatives: [] } };
    const run = runner(new ScriptedPort([unusable, unusable]));

    await expect(run.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "stopped" });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({
      state: "SOLUTION",
      stopReason: "blocking_question",
    });
    expect(published).toContain(REQUIREMENT_ID);
  });
});
