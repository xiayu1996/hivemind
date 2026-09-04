import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import {
  RequirementDecomposer,
  type RequirementDecomposePort,
  type RequirementDecomposeRequest,
} from "./requirement-decompose.js";
import { EpicDecomposer } from "./decompose-runner.js";
import { PlanApprovalStore } from "./plan-approval.js";
import { RequirementStore } from "./requirement-store.js";
import type { RequirementDecompositionCandidate } from "./requirement-artifacts.js";

const REQUIREMENT_ID = "R-abc123def456";
const SCENARIOS = [
  {
    id: `${REQUIREMENT_ID}-s01`,
    given: "值班的人打开看板",
    when: "有一张卡在等人回答",
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
    then: "他一眼看到在等谁、等什么",
  },
  {
    id: `${REQUIREMENT_ID}-s02`,
    given: "值班的人在手机上",
    when: "他想知道今天交付了什么",
    // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
    then: "他看到今天已经交付的清单",
  },
];

function candidate(overrides: Partial<RequirementDecompositionCandidate> = {}): RequirementDecompositionCandidate {
  return {
    epics: [
      {
        id: "CONSOLE1",
        title: "看板首屏",
        businessGoal: "值班的人一眼看到谁在等他",
        body: "值班的人打开首屏就能看到全部在等人回答的卡片。",
        scenarioIds: [SCENARIOS[0]!.id],
      },
      {
        id: "CONSOLE2",
        title: "当日交付清单",
        businessGoal: "值班的人知道今天交付了什么",
        body: "在手机上也能看到今天已经交付的清单。",
        scenarioIds: [SCENARIOS[1]!.id],
      },
    ],
    ...overrides,
  };
}

class ScriptedPort implements RequirementDecomposePort {
  readonly requests: RequirementDecomposeRequest[] = [];
  constructor(private readonly replies: RequirementDecompositionCandidate[]) {}

  async run(input: RequirementDecomposeRequest): Promise<RequirementDecompositionCandidate> {
    this.requests.push(input);
    const reply = this.replies.shift();
    if (!reply) throw new Error("the product manager was asked more times than the test scripted");
    return reply;
  }
}

describe("RequirementDecomposer", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;

  function decomposer(port: RequirementDecomposePort): RequirementDecomposer {
    let time = 5_000;
    return new RequirementDecomposer(client, store, port, { publish: async () => undefined }, () => time++);
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    store = new RequirementStore(client, () => time++);
    await store.createRequirement({
      id: REQUIREMENT_ID,
      notionPageId: "requirement-page",
      title: "给 hivemind 做一个控制台",
      originalRequest: "我想随时知道现在在做什么。",
      repo: "owner/hivemind",
    });
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-1");
    await store.saveDraftPrd(REQUIREMENT_ID, JSON.stringify({
      businessGoal: "值班的人随时看到每张卡进行到哪一步",
      nonGoals: ["这次不做权限"],
      scenarios: SCENARIOS,
    }), "run-prd");
    await store.confirmPrd(REQUIREMENT_ID, 1, "comment-1", "comment", "run-confirm");
    await store.transition(REQUIREMENT_ID, "PRD_CONFIRM", "DECOMPOSING", "system", "run-2");
  });

  afterEach(() => client.close());

  it("hands over Epics the existing intake can take without translation", async () => {
    const outcome = await decomposer(new ScriptedPort([candidate()])).decompose(REQUIREMENT_ID);

    expect(outcome).toMatchObject({ kind: "decomposed" });
    const epics = outcome.kind === "decomposed" ? outcome.epics : [];
    expect(epics.map((epic) => epic.id)).toEqual(["CONSOLE1", "CONSOLE2"]);
    expect(epics[0]?.title.startsWith("CONSOLE1 ")).toBe(true);
    expect(epics[0]?.requirement).toContain("值班的人打开首屏");

    const stored = (await client.execute("SELECT id, state, requirement_id, repo FROM epics ORDER BY id")).rows;
    expect(stored).toMatchObject([
      { id: "CONSOLE1", state: "INTAKE", requirement_id: REQUIREMENT_ID, repo: "owner/hivemind" },
      { id: "CONSOLE2", state: "INTAKE", requirement_id: REQUIREMENT_ID, repo: "owner/hivemind" },
    ]);
    const outbox = (await client.execute("SELECT operation, card_id FROM notion_outbox ORDER BY card_id")).rows;
    expect(outbox).toMatchObject([
      { operation: "create_epic_page", card_id: "CONSOLE1" },
      { operation: "create_epic_page", card_id: "CONSOLE2" },
    ]);
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({ state: "EXECUTING" });
  });

  it("hands its Epics straight into the existing decomposition, no translation step", async () => {
    const outcome = await decomposer(new ScriptedPort([candidate()])).decompose(REQUIREMENT_ID);
    const epic = outcome.kind === "decomposed" ? outcome.epics[0]! : undefined;

    const approvals = new PlanApprovalStore(client, () => 6_000);
    const epicDecomposer = new EpicDecomposer(client, approvals, {
      run: async (request) => {
        expect(request.requirement).toContain("值班的人打开首屏");
        return {
          epicId: request.epicId,
          businessGoal: "值班的人一眼看到谁在等他",
          stories: [{
            id: "S-CONSOLE1-01",
            title: "首屏列出在等人回答的卡片",
            requirement: "值班的人打开首屏就看到全部在等他回答的卡片。",
            scenarios: [{
              id: "S-CONSOLE1-01-a",
              given: "有卡片在等人回答",
              when: "值班的人打开首屏",
              // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external scenario grammar.
              then: "他看到这些卡片",
            }],
            dependsOn: [],
            predictedFootprint: ["console"],
          }],
        };
      },
    }, () => 6_000);

    await expect(epicDecomposer.decompose(epic!)).resolves.toMatchObject({ kind: "presented", stories: 1 });
    await expect(approvals.getEpic("CONSOLE1")).resolves.toMatchObject({ state: "PLAN_APPROVAL" });
  });

  it("refuses a split that leaves a scenario with nobody building it", async () => {
    const missing = candidate({ epics: [candidate().epics[0]!] });
    const port = new ScriptedPort([missing, candidate()]);

    await expect(decomposer(port).decompose(REQUIREMENT_ID)).resolves.toMatchObject({ kind: "decomposed" });
    expect(port.requests[1]?.previousRejections.join(" ")).toContain("no Epic covers scenario");
  });

  it("refuses to reuse an Epic id another piece of work already owns", async () => {
    await client.execute({
      sql: `INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at)
            VALUES ('CONSOLE1', 'other-page', 'CONSOLE1 别人的 Epic', 'EXECUTING', 1, 1)`,
      args: [],
    });
    const port = new ScriptedPort([candidate(), candidate()]);

    const outcome = await decomposer(port).decompose(REQUIREMENT_ID);
    expect(outcome).toMatchObject({ kind: "stopped" });
    expect(port.requests[1]?.previousRejections.join(" ")).toContain("already used");
    await expect(store.getRequirement(REQUIREMENT_ID)).resolves.toMatchObject({
      state: "DECOMPOSING",
      stopReason: "blocking_question",
    });
  });

  it("holds acceptance back until every Epic born from the requirement is delivered", async () => {
    const run = decomposer(new ScriptedPort([candidate()]));
    await run.decompose(REQUIREMENT_ID);

    await expect(run.canEnterAcceptance(REQUIREMENT_ID)).resolves.toBe(false);
    await client.execute("UPDATE epics SET state = 'DONE' WHERE id = 'CONSOLE1'");
    await expect(run.canEnterAcceptance(REQUIREMENT_ID)).resolves.toBe(false);
    await client.execute("UPDATE epics SET state = 'DONE' WHERE id = 'CONSOLE2'");
    await expect(run.canEnterAcceptance(REQUIREMENT_ID)).resolves.toBe(true);
  });

  it("will not decompose a PRD nobody approved", async () => {
    await client.execute({
      sql: "UPDATE requirement_prds SET status = 'draft', confirmed_at = NULL WHERE requirement_id = ?",
      args: [REQUIREMENT_ID],
    });
    await expect(decomposer(new ScriptedPort([candidate()])).decompose(REQUIREMENT_ID))
      .rejects.toThrow(/no confirmed PRD/);
  });
});
