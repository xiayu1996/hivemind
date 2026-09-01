import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { PrdRunner, type PrdPort, type PrdRequest } from "./prd-runner.js";
import { RequirementStore } from "./requirement-store.js";
import type { PrdCandidate } from "./requirement-artifacts.js";

const REQUIREMENT_ID = "R-abc123def456";

function prd(goal: string): PrdCandidate {
  return {
    businessGoal: goal,
    nonGoals: ["这次不做权限"],
    scenarios: [{
      id: `${REQUIREMENT_ID}-s01`,
      given: "值班的人打开看板",
      when: "有一张卡在等人回答",
      // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
      then: "他一眼看到在等谁、等什么",
    }],
  };
}

class ScriptedPort implements PrdPort {
  readonly requests: PrdRequest[] = [];
  constructor(private readonly replies: PrdCandidate[]) {}

  async run(input: PrdRequest): Promise<PrdCandidate> {
    this.requests.push(input);
    const reply = this.replies.shift();
    if (!reply) throw new Error("the product manager was asked more times than the test scripted");
    return reply;
  }
}

describe("PrdRunner", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let published: string[];

  function runner(port: PrdPort): PrdRunner {
    return new PrdRunner(store, port, { publish: async (id: string) => { published.push(id); } });
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
    });
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-clarified");
  });

  afterEach(() => client.close());

  it("writes a draft and then waits: approval is a person's act", async () => {
    const port = new ScriptedPort([prd("值班的人随时看到每张卡进行到哪一步")]);
    const run = runner(port);

    await expect(run.advance(REQUIREMENT_ID)).resolves.toEqual({ kind: "drafted", revision: 1 });
    await expect(run.advance(REQUIREMENT_ID)).resolves.toEqual({ kind: "awaiting", revision: 1 });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "PRD_CONFIRM" });
  });

  it("rewrites once against what the person asked to change", async () => {
    const port = new ScriptedPort([
      prd("值班的人随时看到每张卡进行到哪一步"),
      prd("值班的人在手机上也能看到每张卡进行到哪一步"),
    ]);
    const run = runner(port);
    await run.advance(REQUIREMENT_ID);

    await expect(
      store.requestPrdRevision(REQUIREMENT_ID, 1, "手机上也要能看", "comment-9", "comment", "run-revise"),
    ).resolves.toBe(true);

    await expect(run.advance(REQUIREMENT_ID)).resolves.toEqual({ kind: "drafted", revision: 2 });
    expect(port.requests[1]?.revisionFeedback).toEqual(["手机上也要能看"]);
    await expect(store.getPrd(REQUIREMENT_ID, 1)).resolves.toMatchObject({ status: "superseded" });
  });

  it("moves on only after the person confirms, and never rewrites what they approved", async () => {
    const run = runner(new ScriptedPort([prd("值班的人随时看到每张卡进行到哪一步")]));
    await run.advance(REQUIREMENT_ID);
    await store.confirmPrd(REQUIREMENT_ID, 1, "comment-11", "comment", "run-confirm");

    await expect(run.advance(REQUIREMENT_ID)).resolves.toEqual({ kind: "confirmed", revision: 1 });
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "DECOMPOSING" });
    await expect(store.saveDraftPrd(REQUIREMENT_ID, "{}", "run-late")).rejects.toThrow(/confirmed/);
  });

  it("stops for a person when the PRD keeps coming back unusable", async () => {
    const port = new ScriptedPort([prd("用 react 组件搭一个看板"), prd("把数据库表结构画出来")]);
    const run = runner(port);

    await expect(run.advance(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "stopped" });
    expect(port.requests[1]?.previousRejections[0]).toContain("implementation language");
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({
      state: "PRD_CONFIRM",
      stopReason: "blocking_question",
    });
    expect(published).toContain(REQUIREMENT_ID);
  });
});
