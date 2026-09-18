import { createClient, type Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlStoryDetailReadPort, currentRound, roundByNumber } from "./story-detail.js";
import {
  formatRoundBlockerLine,
  formatRoundCostValue,
  formatRoundPhaseLine,
  formatRoundResultLine,
  formatRoundTriggerLine,
  formatTotalCostValue,
} from "../../console-ui/src/pages/detail/contracts.js";

const CARD = "S-R237511DT-02";
const T0 = 1_700_000_000_000;

async function memoryClient(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  return client;
}

function port(client: Client): LibsqlStoryDetailReadPort {
  return new LibsqlStoryDetailReadPort(client, () => T0);
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
  phase: string,
  round: number,
  startedAt: number,
  endedAt: number | null,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO phase_runs (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [runId, CARD, phase, round, "a".repeat(64), endedAt === null ? "running" : "completed", startedAt, endedAt],
  });
}

async function seedRejectedVerify(client: Client, round: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO verify_records (card_id, round, code_session_id, verify_session_id, verdict, created_at)
          VALUES (?, ?, ?, ?, 'rejected', ?)`,
    args: [CARD, round, `code-${round}`, `verify-${round}`, T0],
  });
}

async function seedSpec(client: Client, scenarioId: string, seq: number, title: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO story_specs (spec_id, story_id, seq, text, title, status)
          VALUES (?, ?, ?, ?, ?, 'pending')`,
    args: [scenarioId, CARD, seq, `Given 前提; when 动作; then ${title}`, title],
  });
}

async function seedConclusion(
  client: Client,
  scenarioId: string,
  seq: number,
  title: string,
  round: number,
  outcome: "passed" | "failed",
  carriedFrom: number | null = null,
): Promise<number> {
  await seedSpec(client, scenarioId, seq, title);
  const inserted = await client.execute({
    sql: `INSERT INTO verify_scenario_results
            (card_id, scenario_id, round, dod_version, scenario_version, verified_tree_sha, outcome, carried_from, created_at)
          VALUES (?, ?, ?, 'dod-v1', ?, 'tree-1', ?, ?, ?)`,
    args: [CARD, scenarioId, round, `sv-${scenarioId}`, outcome, carriedFrom, T0],
  });
  return Number(inserted.lastInsertRowid ?? 0);
}

async function seedCost(client: Client, runId: string, costUsd: number, ts: number): Promise<void> {
  await client.execute({
    sql: `INSERT INTO cost_entries (run_id, card_id, phase, provider, model_id, cost_usd, ts)
          VALUES (?, ?, 'CODE', 'anthropic', 'claude', ?, ?)`,
    args: [runId, CARD, costUsd, ts],
  });
}

/** The card the DoD describes: three rounds, the second bought by a refused
 * result, the third bought by a person moving the card on. Round 1 ran the
 * front phases and CODE; rounds 2 and 3 are CODE rounds. */
async function seedThreeRoundCard(): Promise<Client> {
  const client = await memoryClient();
  await seedStory(client, CARD, "费用投影核对", "MERGE");
  await seedRun(client, "run-r1-shape", "SHAPE", 1, T0, T0 + 10_000);
  await seedRun(client, "run-r1-code", "CODE", 1, T0 + 20_000, T0 + 30_000);
  await seedRun(client, "run-r2-code", "CODE", 2, T0 + 40_000, T0 + 50_000);
  await seedRun(client, "run-r3-code", "CODE", 3, T0 + 60_000, null);
  await seedRejectedVerify(client, 1);
  await seedConclusion(client, "S-R237511DT-02-alpha", 1, "首轮验收", 1, "passed");
  await seedConclusion(client, "S-R237511DT-02-beta", 2, "返工验收", 2, "passed");
  await seedConclusion(client, "S-R237511DT-02-gamma", 3, "当前轮验收一", 3, "passed");
  await seedConclusion(client, "S-R237511DT-02-delta", 4, "当前轮验收二", 3, "passed");
  await seedConclusion(client, "S-R237511DT-02-epsilon", 5, "当前轮验收三", 3, "failed");
  await seedCost(client, "run-r1-shape", 0.4, T0 + 11_000);
  await seedCost(client, "run-r1-code", 0.5, T0 + 31_000);
  await seedCost(client, "run-r2-code", 0.96, T0 + 51_000);
  await seedCost(client, "run-r3-code", 1.24, T0 + 61_000);
  // A second review lane has no phase run of its own; the card still paid for it.
  await seedCost(client, "review-lane-2", 0.7, T0 + 62_000);
  return client;
}

describe("task detail read port", () => {
  it("@scenario S-R237511DT-02-current 打开任务读到当前轮的触发原因、阶段、结果、卡点与两个费用口径", async () => {
    const client = await seedThreeRoundCard();
    try {
      const result = await port(client).readStoryDetail(CARD);

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const snapshot = result.snapshot;
      expect(snapshot.rounds.map((entry) => entry.round)).toEqual([1, 2, 3]);
      const shown = currentRound(snapshot);
      expect(shown?.round).toBe(3);
      expect(formatRoundTriggerLine(shown!)).toBe("触发原因：重新开始");
      expect(formatRoundPhaseLine(shown!)).toBe("阶段：CODE");
      expect(formatRoundResultLine(shown!)).toBe("已取得的结果：2 项验收已通过");
      expect(formatRoundBlockerLine(shown!)).toBe("卡点：1 项验收未通过");
      expect(formatRoundCostValue(shown!, 3)).toBe("$1.24（本任务当前轮）");
      expect(formatTotalCostValue(snapshot.totalCostUsd)).toBe("$3.80（本任务全部轮次）");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-02-current 未被选择的历史轮次不会并入当前轮的验收结论", async () => {
    const client = await seedThreeRoundCard();
    try {
      const result = await port(client).readStoryDetail(CARD);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;

      const shown = currentRound(result.snapshot)!;

      expect(shown.acceptance.map((entry) => entry.scenarioId)).toEqual([
        "S-R237511DT-02-gamma",
        "S-R237511DT-02-delta",
        "S-R237511DT-02-epsilon",
      ]);
      expect(shown.acceptance.map((entry) => entry.scenarioId)).not.toContain("S-R237511DT-02-beta");
      expect(shown.acceptance.map((entry) => entry.text)).toEqual(["当前轮验收一", "当前轮验收二", "当前轮验收三"]);
      expect(shown.costUsd).toBeCloseTo(1.24, 6);
      expect(result.snapshot.totalCostUsd).toBeCloseTo(3.8, 6);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-02-history 第 2 轮带自己的触发原因、阶段、结果与费用", async () => {
    const client = await seedThreeRoundCard();
    try {
      const result = await port(client).readStoryDetail(CARD);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;

      const second = roundByNumber(result.snapshot, 2);

      expect(formatRoundTriggerLine(second!)).toBe("触发原因：返工");
      expect(second?.phase).toBe("CODE");
      expect(second?.acceptance.map((entry) => entry.scenarioId)).toEqual(["S-R237511DT-02-beta"]);
      expect(formatRoundResultLine(second!)).toBe("已取得的结果：1 项验收已通过");
      expect(formatRoundCostValue(second!, 3)).toBe("$0.96（本任务第 2 轮）");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-02-history 第 1 轮与当前轮的内容不会并入第 2 轮", async () => {
    const client = await seedThreeRoundCard();
    try {
      const result = await port(client).readStoryDetail(CARD);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;

      const second = roundByNumber(result.snapshot, 2)!;

      expect(second.acceptance.map((entry) => entry.scenarioId)).not.toContain("S-R237511DT-02-alpha");
      expect(second.acceptance.map((entry) => entry.scenarioId)).not.toContain("S-R237511DT-02-gamma");
      expect(second.costUsd).toBeCloseTo(0.96, 6);
      expect(second.costUsd).not.toBeCloseTo(result.snapshot.rounds[0]!.costUsd, 6);
      expect(second.costUsd).not.toBeCloseTo(result.snapshot.rounds[2]!.costUsd, 6);
      expect(formatTotalCostValue(result.snapshot.totalCostUsd)).toBe("$3.80（本任务全部轮次）");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-02-history 带入的结论属于产生它的那一轮", async () => {
    const client = await seedThreeRoundCard();
    try {
      const beta = (await client.execute({
        sql: "SELECT id FROM verify_scenario_results WHERE card_id = ? AND scenario_id = ?",
        args: [CARD, "S-R237511DT-02-beta"],
      })).rows[0];
      await seedConclusion(client, "S-R237511DT-02-zeta", 6, "带入的验收", 3, "passed", Number(beta?.id));

      const result = await port(client).readStoryDetail(CARD);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const third = roundByNumber(result.snapshot, 3)!;

      expect(third.acceptance.map((entry) => entry.scenarioId)).not.toContain("S-R237511DT-02-zeta");
      expect(third.acceptance).toHaveLength(3);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-02-waiting 阶段还在进行且没有结论时本轮结果标记为未产生", async () => {
    const client = await memoryClient();
    try {
      await seedStory(client, CARD, "费用投影核对", "CODE");
      await seedRun(client, "run-r1-code", "CODE", 1, T0, null);
      await seedCost(client, "run-r1-code", 0.35, T0 + 1_000);

      const result = await port(client).readStoryDetail(CARD);

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const shown = currentRound(result.snapshot)!;
      expect(shown.resultPending).toBe(true);
      expect(formatRoundResultLine(shown)).toBe("本轮结果尚未产生，将自动刷新");
      expect(formatRoundPhaseLine(shown)).toBe("阶段：CODE");
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-02-empty 还没有开始任何轮次的任务读出来是空轮次", async () => {
    const client = await memoryClient();
    try {
      await seedStory(client, CARD, "费用投影核对", "QUEUED");

      const result = await port(client).readStoryDetail(CARD);

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.snapshot.rounds).toEqual([]);
      expect(currentRound(result.snapshot)).toBeNull();
      expect(result.snapshot.totalCostUsd).toBe(0);
    } finally {
      client.close();
    }
  });

  it("@scenario S-R237511DT-02-error 账本读不动时返回读取失败而不是一份空快照", async () => {
    const broken = {
      execute: () => Promise.reject(new Error("ledger unavailable")),
    } as unknown as Client;
    const result = await new LibsqlStoryDetailReadPort(broken, () => T0).readStoryDetail(CARD);

    expect(result.kind).toBe("failed");
    expect(JSON.stringify(result)).not.toContain('"rounds"');
  });

  it("@scenario S-R237511DT-02-error 没有这张卡时返回找不到而不是读取失败", async () => {
    const client = await memoryClient();
    try {
      const result = await port(client).readStoryDetail("S-MISSING-99");
      expect(result.kind).toBe("not_found");
    } finally {
      client.close();
    }
  });
});
