import { createClient, type Client } from "@libsql/client";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import {
  LibsqlStoryProgressReadPort,
  currentRound,
  formatLimitLine,
  formatLimitStateLine,
  formatRoundBlockerLine,
  formatRoundCostValue,
  formatRoundPhaseLine,
  formatRoundResultLine,
  formatRoundTriggerLine,
  formatTotalCostValue,
  formatWorkStateLine,
  limitStateOf,
  registerStoryProgressRoute,
  roundByNumber,
  type StoryProgressReadPort,
} from "./story-progress.js";

const CARD = "S-R237511DT-01";
const T0 = 1_700_000_000_000;

async function memoryClient(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  return client;
}

function port(client: Client): LibsqlStoryProgressReadPort {
  return new LibsqlStoryProgressReadPort(client, () => T0);
}

async function seedStory(client: Client, id: string, title: string, state: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at)
          VALUES (?, ?, ?, 'requirement text', ?, ?, ?)`,
    args: [id, `page-${id}`, title, state, T0, T0],
  });
}

async function seedRun(
  client: Client,
  runId: string,
  cardId: string,
  phase: string,
  round: number,
  startedAt: number,
  endedAt: number | null,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [runId, cardId, phase, round, "a".repeat(64), endedAt === null ? "running" : "completed", startedAt, endedAt],
  });
}

async function seedRejectedVerify(client: Client, cardId: string, round: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO verify_records (card_id, round, code_session_id, verify_session_id, verdict, created_at)
          VALUES (?, ?, ?, ?, 'rejected', ?)`,
    args: [cardId, round, `code-${round}`, `verify-${round}`, T0],
  });
}

async function seedSpec(client: Client, cardId: string, scenarioId: string, seq: number, title: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO story_specs (spec_id, story_id, seq, text, title, status)
          VALUES (?, ?, ?, ?, ?, 'pending')`,
    args: [scenarioId, cardId, seq, `Given 前提; when 动作; then ${title}`, title],
  });
}

async function seedConclusion(
  client: Client,
  cardId: string,
  scenarioId: string,
  seq: number,
  title: string,
  round: number,
  outcome: "passed" | "failed",
  carriedFrom: number | null = null,
): Promise<number> {
  await seedSpec(client, cardId, scenarioId, seq, title);
  const inserted = await client.execute({
    sql: `INSERT INTO verify_scenario_results
            (card_id, scenario_id, round, dod_version, scenario_version, verified_tree_sha, outcome, carried_from, created_at)
          VALUES (?, ?, ?, 'dod-v1', ?, 'tree-1', ?, ?, ?)`,
    args: [cardId, scenarioId, round, `sv-${scenarioId}`, outcome, carriedFrom, T0],
  });
  return Number(inserted.lastInsertRowid ?? 0);
}

async function seedCost(client: Client, runId: string, cardId: string, costUsd: number, ts: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO cost_entries (run_id, card_id, phase, provider, model_id, cost_usd, ts)
          VALUES (?, ?, 'CODE', 'anthropic', 'claude', ?, ?)`,
    args: [runId, cardId, costUsd, ts],
  });
}

async function seedCeiling(client: Client, usd: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO config_entries (scope_id, key, value_json, version, updated_by, updated_at)
          VALUES ('global', 'cost.perCardUsdCeiling', ?, 1, 'test', ?)`,
    args: [JSON.stringify(usd), T0],
  });
}

/** The card the DoD describes: three rounds, the second bought by a refused
 * verification, the third bought by a person moving the card on. Round 1 ran
 * the front phases and CODE; rounds 2 and 3 are CODE rounds, and round 3 is now
 * in VERIFY. */
async function seedThreeRoundCard(): Promise<Client> {
  const client = await memoryClient();
  await seedCeiling(client, 10);
  await seedStory(client, CARD, "费用投影核对", "VERIFY");
  await seedRun(client, "run-r1-shape", CARD, "SHAPE", 1, T0, T0 + 10_000);
  await seedRun(client, "run-r1-code", CARD, "CODE", 1, T0 + 20_000, T0 + 30_000);
  await seedRun(client, "run-r2-code", CARD, "CODE", 2, T0 + 40_000, T0 + 50_000);
  await seedRun(client, "run-r3-code", CARD, "CODE", 3, T0 + 60_000, T0 + 70_000);
  await seedRun(client, "run-r3-verify", CARD, "VERIFY", 3, T0 + 80_000, null);
  await seedRejectedVerify(client, CARD, 1);
  await seedConclusion(client, CARD, "S-R237511DT-01-alpha", 1, "首轮验收", 1, "passed");
  await seedConclusion(client, CARD, "S-R237511DT-01-beta", 2, "返工验收", 2, "passed");
  await seedConclusion(client, CARD, "S-R237511DT-01-gamma", 3, "当前轮验收一", 3, "passed");
  await seedConclusion(client, CARD, "S-R237511DT-01-delta", 4, "当前轮验收二", 3, "passed");
  await seedConclusion(client, CARD, "S-R237511DT-01-epsilon", 5, "当前轮验收三", 3, "passed");
  await seedConclusion(client, CARD, "S-R237511DT-01-zeta", 6, "当前轮验收四", 3, "failed");
  await seedCost(client, "run-r1-shape", CARD, 0.4, T0 + 11_000);
  await seedCost(client, "run-r1-code", CARD, 0.5, T0 + 31_000);
  await seedCost(client, "run-r2-code", CARD, 0.96, T0 + 51_000);
  await seedCost(client, "run-r3-code", CARD, 0.6, T0 + 71_000);
  await seedCost(client, "run-r3-verify", CARD, 0.64, T0 + 81_000);
  // A second review lane has no phase run of its own; the card still paid for it.
  await seedCost(client, "review-lane-2", CARD, 0.7, T0 + 90_000);
  return client;
}

async function seedWaitingCard(): Promise<Client> {
  const client = await memoryClient();
  await seedStory(client, "S-R237511DT-91", "等待结果的卡片", "CODE");
  await seedRun(client, "run-w1-code", "S-R237511DT-91", "CODE", 1, T0, null);
  await seedCost(client, "run-w1-code", "S-R237511DT-91", 0.35, T0 + 1_000);
  return client;
}

async function seedOverLimitCard(): Promise<Client> {
  const client = await memoryClient();
  await seedCeiling(client, 10);
  await seedStory(client, "S-R237511DT-92", "超限的卡片", "VERIFY");
  await seedRun(client, "run-o1-verify", "S-R237511DT-92", "VERIFY", 1, T0, T0 + 5_000);
  await seedCost(client, "run-o1-verify", "S-R237511DT-92", 12.4, T0 + 6_000);
  return client;
}

function routeApp(readPort: StoryProgressReadPort): FastifyInstance {
  const app = Fastify();
  registerStoryProgressRoute(app, readPort);
  return app;
}

describe("requirements progress read port", () => {
  it("@scenario S-R237511DT-01-current 打开需求读到当前轮的触发原因、阶段、结果、卡点与两个费用口径", async () => {
    const client = await seedThreeRoundCard();
    try {
      const result = await port(client).readStoryProgress(CARD);

      expect(result.kind).toBe("progress");
      if (result.kind !== "progress") return;
      const snapshot = result.snapshot;
      expect(snapshot.rounds.map((entry) => entry.round)).toEqual([1, 2, 3]);
      const shown = currentRound(snapshot);
      expect(shown?.round).toBe(3);
      expect(formatRoundTriggerLine(shown!)).toBe("触发原因：重新开始");
      expect(formatRoundPhaseLine(shown!)).toBe("阶段：VERIFY");
      expect(formatRoundResultLine(shown!)).toBe("已取得的结果：3 项验收已通过");
      expect(formatRoundBlockerLine(shown!)).toBe("卡点：1 项验收未通过");
      expect(formatRoundCostValue(shown!, 3)).toBe("$1.24（本需求当前轮）");
      expect(formatTotalCostValue(snapshot.totalCostUsd)).toBe("$3.80（本需求全部轮次）");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-01-current 未被选择的历史轮次不会并入当前轮的验收结论", async () => {
    const client = await seedThreeRoundCard();
    try {
      const result = await port(client).readStoryProgress(CARD);
      expect(result.kind).toBe("progress");
      if (result.kind !== "progress") return;

      const shown = currentRound(result.snapshot)!;
      const items = shown.result.state === "available" ? shown.result.items : [];

      expect(items.map((entry) => entry.scenarioId)).toEqual([
        "S-R237511DT-01-gamma",
        "S-R237511DT-01-delta",
        "S-R237511DT-01-epsilon",
        "S-R237511DT-01-zeta",
      ]);
      expect(items.map((entry) => entry.scenarioId)).not.toContain("S-R237511DT-01-beta");
      expect(shown.blockers.map((entry) => entry.scenarioId)).toEqual(["S-R237511DT-01-zeta"]);
      expect(shown.costUsd).toBeCloseTo(1.24, 6);
      expect(result.snapshot.totalCostUsd).toBeCloseTo(3.8, 6);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-01-history 第 2 轮带自己的触发原因、阶段、结果与费用", async () => {
    const client = await seedThreeRoundCard();
    try {
      const result = await port(client).readStoryProgress(CARD);
      expect(result.kind).toBe("progress");
      if (result.kind !== "progress") return;

      const second = roundByNumber(result.snapshot, 2);

      expect(formatRoundTriggerLine(second!)).toBe("触发原因：返工");
      expect(second?.phase).toBe("CODE");
      const items = second?.result.state === "available" ? second.result.items : [];
      expect(items.map((entry) => entry.scenarioId)).toEqual(["S-R237511DT-01-beta"]);
      expect(formatRoundResultLine(second!)).toBe("已取得的结果：1 项验收已通过");
      expect(formatRoundCostValue(second!, 3)).toBe("$0.96（本需求第 2 轮）");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-01-history 第 1 轮与当前轮的内容不会并入第 2 轮", async () => {
    const client = await seedThreeRoundCard();
    try {
      const result = await port(client).readStoryProgress(CARD);
      expect(result.kind).toBe("progress");
      if (result.kind !== "progress") return;

      const second = roundByNumber(result.snapshot, 2)!;
      const items = second.result.state === "available" ? second.result.items : [];

      expect(items.map((entry) => entry.scenarioId)).not.toContain("S-R237511DT-01-alpha");
      expect(items.map((entry) => entry.scenarioId)).not.toContain("S-R237511DT-01-gamma");
      expect(second.costUsd).toBeCloseTo(0.96, 6);
      expect(second.costUsd).not.toBeCloseTo(result.snapshot.rounds[0]!.costUsd, 6);
      expect(second.costUsd).not.toBeCloseTo(result.snapshot.rounds[2]!.costUsd, 6);
      expect(formatTotalCostValue(result.snapshot.totalCostUsd)).toBe("$3.80（本需求全部轮次）");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-01-history 带入的结论属于产生它的那一轮", async () => {
    const client = await seedThreeRoundCard();
    try {
      const zeta = (await client.execute({
        sql: "SELECT id FROM verify_scenario_results WHERE card_id = ? AND scenario_id = ?",
        args: [CARD, "S-R237511DT-01-zeta"],
      })).rows[0];
      await seedConclusion(client, CARD, "S-R237511DT-01-carried", 7, "带入的验收", 3, "passed", Number(zeta?.id));

      const result = await port(client).readStoryProgress(CARD);
      expect(result.kind).toBe("progress");
      if (result.kind !== "progress") return;
      const third = roundByNumber(result.snapshot, 3)!;
      const items = third.result.state === "available" ? third.result.items : [];

      expect(items.map((entry) => entry.scenarioId)).not.toContain("S-R237511DT-01-carried");
      expect(items).toHaveLength(4);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-01-waiting 阶段还在进行且没有结论时本轮结果标记为未产生", async () => {
    const client = await seedWaitingCard();
    try {
      const result = await port(client).readStoryProgress("S-R237511DT-91");

      expect(result.kind).toBe("progress");
      if (result.kind !== "progress") return;
      const shown = currentRound(result.snapshot)!;
      expect(shown.result.state).toBe("pending");
      expect(formatRoundResultLine(shown)).toBe("本轮结果尚未产生，将自动刷新");
      expect(formatRoundPhaseLine(shown)).toBe("阶段：CODE");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-01-empty 还没有开始任何轮次的需求读出来是空进展", async () => {
    const client = await memoryClient();
    try {
      await seedStory(client, "S-R237511DT-93", "尚未开始的卡片", "QUEUED");

      const result = await port(client).readStoryProgress("S-R237511DT-93");

      expect(result.kind).toBe("empty");
      expect(JSON.stringify(result)).not.toContain("totalCostUsd");
      expect(JSON.stringify(result)).not.toContain("rounds");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-01-overlimit 当前轮超过上限时读面给出上限与工作仍在继续", async () => {
    const client = await seedOverLimitCard();
    try {
      const result = await port(client).readStoryProgress("S-R237511DT-92");

      expect(result.kind).toBe("progress");
      if (result.kind !== "progress") return;
      const snapshot = result.snapshot;

      expect(limitStateOf(snapshot)).toBe("over");
      expect(formatRoundCostValue(currentRound(snapshot)!, snapshot.currentRoundId)).toBe("$12.40（本需求当前轮）");
      expect(formatLimitLine(snapshot)).toBe("上限 $10.00");
      expect(formatLimitStateLine(snapshot)).toBe("已超限");
      expect(formatWorkStateLine(snapshot)).toBe("工作仍继续");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-01-error 账本读不动时返回读取失败而不是一份空快照", async () => {
    const broken = {
      execute: () => Promise.reject(new Error("ledger unavailable")),
    } as unknown as Client;
    const result = await new LibsqlStoryProgressReadPort(broken, () => T0).readStoryProgress(CARD);

    expect(result.kind).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("rounds");
  });

  it("@scenario S-R237511DT-01-error 没有这张卡时返回找不到而不是读取失败", async () => {
    const client = await memoryClient();
    try {
      const result = await port(client).readStoryProgress("S-MISSING-99");
      expect(result.kind).toBe("not_found");
    } finally {
      client.close();
    }
  });
});

describe("requirements progress read route", () => {
  it("@scenario S-R237511DT-01-empty 空进展的路由成功回答且不含阶段与费用", async () => {
    const app = routeApp({ readStoryProgress: async () => ({ kind: "empty", storyId: CARD }) });
    try {
      const response = await app.inject({ method: "GET", url: `/api/stories/${CARD}/progress` });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("totalCostUsd");
      expect(response.body).not.toContain("currentRoundId");
    } finally {
      await app.close();
    }
  });

  it("@scenario S-R237511DT-01-error 需求不存在时路由回答找不到", async () => {
    const app = routeApp({ readStoryProgress: async () => ({ kind: "not_found" }) });
    try {
      const response = await app.inject({ method: "GET", url: `/api/stories/${CARD}/progress` });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("rounds");
    } finally {
      await app.close();
    }
  });

  it("@scenario S-R237511DT-01-error 进展读不通时路由回答非成功且不换一张卡", async () => {
    const app = routeApp({ readStoryProgress: async () => ({ kind: "failed" }) });
    try {
      const response = await app.inject({ method: "GET", url: `/api/stories/${CARD}/progress` });

      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("S-R237511DT-99");
    } finally {
      await app.close();
    }
  });

  it("@scenario S-R237511DT-01-error 投影不成立时路由拒绝而不是猜一个当前轮", async () => {
    const app = routeApp({
      readStoryProgress: async () => ({ kind: "invalid_projection", reason: "round ordinals must be unique and increasing" }),
    });
    try {
      const response = await app.inject({ method: "GET", url: `/api/stories/${CARD}/progress` });

      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain("currentRoundId");
    } finally {
      await app.close();
    }
  });
});
