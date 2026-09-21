import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CurrentWorkReadPort,
  RequirementCurrentWorkDetail,
  RunningOverviewSnapshot,
  TaskCurrentWorkDetail,
} from "./current-work-contracts.js";
import { registerCurrentWorkRoutes } from "./current-work-routes.js";

const REQUIREMENT_ID = "R-237511dd5162";
const CARD_ID = "S-R237511DT-02";
const NOW = 1_700_000_000_000;

const overview: RunningOverviewSnapshot = {
  entries: [
    {
      kind: "requirement",
      requirementId: REQUIREMENT_ID,
      title: "Hivemind 的 web 管理后台",
      state: "running",
      phase: "绘制原型",
    },
    {
      kind: "task",
      cardId: CARD_ID,
      requirementId: REQUIREMENT_ID,
      title: "费用投影核对",
      state: "running",
      phase: "编写改动",
    },
  ],
  generatedAt: NOW,
};

const requirement: RequirementCurrentWorkDetail = {
  kind: "requirement",
  requirementId: REQUIREMENT_ID,
  title: "Hivemind 的 web 管理后台",
  state: "running",
  currentRound: {
    round: 3,
    phase: "绘制原型",
    results: [{ resultId: "approved-direction", text: "页面清单与浅色运行控制台方向已批准" }],
    blockers: [{ blockerId: "prototype-gate", text: "等待原型出口检查" }],
    costUsd: 3.84,
    startedAt: NOW,
  },
  historicalRounds: [
    { round: 1, phase: "澄清需求", trigger: "first_run" },
    { round: 2, phase: "确定方案", trigger: "rework" },
  ],
  tasks: [
    {
      kind: "task",
      cardId: CARD_ID,
      requirementId: REQUIREMENT_ID,
      title: "费用投影核对",
      state: "running",
    },
  ],
  generatedAt: NOW,
};

const task: TaskCurrentWorkDetail = {
  kind: "task",
  cardId: CARD_ID,
  title: "费用投影核对",
  state: "running",
  currentRound: {
    round: 3,
    phase: "编写改动",
    results: [
      { resultId: "accepted-1", text: "费用范围已核对" },
      { resultId: "accepted-2", text: "美元金额已核对" },
    ],
    blockers: [{ blockerId: "cost-basis", text: "费用口径仍有 1 项待核对" }],
    costUsd: 1.24,
    startedAt: NOW,
  },
  historicalRounds: [
    { round: 1, phase: "明确范围", trigger: "first_run" },
    { round: 2, phase: "返工", trigger: "rework" },
  ],
  parentRequirement: { requirementId: REQUIREMENT_ID, title: "Hivemind 的 web 管理后台" },
  generatedAt: NOW,
};

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function appWith(port: CurrentWorkReadPort) {
  const app = Fastify({ logger: false });
  registerCurrentWorkRoutes(app, port);
  apps.push(app);
  return app;
}

function successfulPort(): CurrentWorkReadPort {
  return {
    readRunningOverview: vi.fn(async () => ({ kind: "ok" as const, snapshot: overview })),
    readRequirementDetail: vi.fn(async () => ({ kind: "ok" as const, detail: requirement })),
    readTaskDetail: vi.fn(async () => ({ kind: "ok" as const, detail: task })),
  };
}

describe("current work read routes", () => {
  it("@scenario S-R237511DT-03-overview 运行总览返回标题、正确身份、阶段及可导航句柄", async () => {
    const app = appWith(successfulPort());
    const response = await app.inject({ method: "GET", url: "/api/current-work" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(overview);
    expect(response.body).toContain("Hivemind 的 web 管理后台");
    expect(response.body).toContain("费用投影核对");
    expect(response.body).not.toContain('"title":"S-R237511DT-02"');
  });

  it("@scenario S-R237511DT-03-overview 总览读取失败不能伪装成没有运行项", async () => {
    const port = successfulPort();
    port.readRunningOverview = vi.fn(async () => ({ kind: "failed" as const, message: "ledger unavailable" }));
    const response = await appWith(port).inject({ method: "GET", url: "/api/current-work" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).not.toHaveProperty("entries");
  });

  it("@scenario S-R237511DT-03-requirement 需求详情接口只返回当前轮摘要、历史引用和所属任务", async () => {
    const port = successfulPort();
    const response = await appWith(port).inject({
      method: "GET",
      url: `/api/requirements/${REQUIREMENT_ID}/detail`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(requirement);
    expect(response.json().currentRound).toMatchObject({
      round: 3,
      phase: "绘制原型",
      results: [{ text: "页面清单与浅色运行控制台方向已批准" }],
      blockers: [{ text: "等待原型出口检查" }],
      costUsd: 3.84,
    });
    expect(port.readRequirementDetail).toHaveBeenCalledOnce();
    expect(port.readRequirementDetail).toHaveBeenCalledWith(REQUIREMENT_ID);
  });

  it("@scenario S-R237511DT-03-requirement 需求不存在与台账读取失败使用不同响应", async () => {
    const missing = successfulPort();
    missing.readRequirementDetail = vi.fn(async () => ({ kind: "not_found" as const }));
    const unavailable = successfulPort();
    unavailable.readRequirementDetail = vi.fn(async () => ({ kind: "failed" as const, message: "ledger unavailable" }));

    const missingResponse = await appWith(missing).inject({
      method: "GET",
      url: "/api/requirements/R-missing/detail",
    });
    const failedResponse = await appWith(unavailable).inject({
      method: "GET",
      url: `/api/requirements/${REQUIREMENT_ID}/detail`,
    });

    expect(missingResponse.statusCode).toBe(404);
    expect(failedResponse.statusCode).toBe(503);
  });

  it("@scenario S-R237511DT-03-task 任务详情接口返回标题、任务身份和本轮两项结果", async () => {
    const port = successfulPort();
    const response = await appWith(port).inject({
      method: "GET",
      url: `/api/stories/${CARD_ID}/detail`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(task);
    expect(response.json()).toMatchObject({
      kind: "task",
      title: "费用投影核对",
      currentRound: {
        round: 3,
        phase: "编写改动",
        results: [{ text: "费用范围已核对" }, { text: "美元金额已核对" }],
        blockers: [{ text: "费用口径仍有 1 项待核对" }],
        costUsd: 1.24,
      },
    });
    expect(response.body).not.toContain('"title":"S-R237511DT-02"');
  });

  it("@scenario S-R237511DT-03-task 任务读取失败不返回需求详情或空摘要", async () => {
    const port = successfulPort();
    port.readTaskDetail = vi.fn(async () => ({ kind: "failed" as const, message: "ledger unavailable" }));
    const response = await appWith(port).inject({
      method: "GET",
      url: `/api/stories/${CARD_ID}/detail`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).not.toHaveProperty("currentRound");
    expect(port.readRequirementDetail).not.toHaveBeenCalled();
  });

  it("@scenario S-R237511DT-03-taskentry 需求详情保留任务标题、身份、运行状态和任务句柄", async () => {
    const response = await appWith(successfulPort()).inject({
      method: "GET",
      url: `/api/requirements/${REQUIREMENT_ID}/detail`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().tasks).toEqual([
      {
        kind: "task",
        cardId: CARD_ID,
        requirementId: REQUIREMENT_ID,
        title: "费用投影核对",
        state: "running",
      },
    ]);
  });

  it("@scenario S-R237511DT-03-taskentry 选择任务句柄只读取任务而不再次返回需求费用", async () => {
    const port = successfulPort();
    const response = await appWith(port).inject({
      method: "GET",
      url: `/api/stories/${CARD_ID}/detail`,
    });

    expect(response.statusCode).toBe(200);
    expect(port.readTaskDetail).toHaveBeenCalledWith(CARD_ID);
    expect(port.readRequirementDetail).not.toHaveBeenCalled();
    expect(response.json().currentRound.costUsd).toBe(1.24);
    expect(response.json().currentRound.costUsd).not.toBe(3.84);
  });
});
