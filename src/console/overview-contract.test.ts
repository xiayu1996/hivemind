import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import type {
  OverviewRefreshController,
  OverviewSnapshot,
  OverviewSnapshotTransport,
} from "./overview-contract.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const RANGE_START = NOW - 7 * DAY_MS;
const clients: Client[] = [];

async function database(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await migrate(client);
  return client;
}

async function overview(client: Client, nowMs = NOW): Promise<OverviewSnapshot> {
  const contract = await import("./overview-contract.js");
  expect(contract.createLibsqlOverviewReader).toEqual(expect.any(Function));
  return contract.createLibsqlOverviewReader(client).readOverview({ nowMs, timeZone: "Asia/Shanghai" });
}

function requirement(input: {
  id: string;
  title: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  stopReason?: string;
}): { sql: string; args: Array<string | number | null> } {
  return {
    sql: `INSERT INTO requirements
            (id, notion_page_id, title, state, original_request, stop_reason, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'request', ?, ?, ?)`,
    args: [input.id, `page-${input.id}`, input.title, input.state, input.stopReason ?? null, input.createdAt, input.updatedAt],
  };
}

function story(input: {
  id: string;
  title: string;
  state: string;
  phase?: string;
  createdAt: number;
  updatedAt: number;
  epicId?: string;
  stopReason?: string;
}): { sql: string; args: Array<string | number | null> } {
  return {
    sql: `INSERT INTO stories
            (id, epic_id, notion_page_id, title, requirement, state, phase, stop_reason, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'Requirement', ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.epicId ?? null,
      `page-${input.id}`,
      input.title,
      input.state,
      input.phase ?? null,
      input.stopReason ?? null,
      input.createdAt,
      input.updatedAt,
    ],
  };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
});

describe("overview snapshot classification", () => {
  it("@scenario S-R237511OV-01-todo returns each open reply, approval and choice once in longest-waiting order", async () => {
    const client = await database();
    await client.batch([
      requirement({ id: "R-REPLY", title: "支付重试规则", state: "CLARIFY", createdAt: 10, updatedAt: 20 }),
      requirement({ id: "R-CHOICE", title: "费用统计时区", state: "CLARIFY", createdAt: 30, updatedAt: 40 }),
      requirement({ id: "R-APPROVAL", title: "后台首屏", state: "PRD_CONFIRM", createdAt: 50, updatedAt: 60 }),
      requirement({ id: "R-HANDLED", title: "已经处理", state: "CLARIFY", createdAt: 70, updatedAt: 80 }),
      {
        sql: `INSERT INTO requirement_clarify_rounds
                (requirement_id, round, questions, asked_at)
              VALUES ('R-REPLY', 1, ?, 100)`,
        args: [JSON.stringify([{ question: "失败后重试多久？", options: [] }])],
      },
      {
        sql: `INSERT INTO requirement_clarify_rounds
                (requirement_id, round, questions, asked_at)
              VALUES ('R-CHOICE', 1, ?, 200)`,
        args: [JSON.stringify([{ question: "使用哪个时区？", options: [{ label: "上海" }, { label: "伦敦" }] }])],
      },
      {
        sql: `INSERT INTO requirement_prds
                (requirement_id, revision, body, status, created_at)
              VALUES ('R-APPROVAL', 1, '{}', 'draft', 300)`,
        args: [],
      },
      {
        sql: `INSERT INTO requirement_clarify_rounds
                (requirement_id, round, questions, asked_at, answered_at, answers)
              VALUES ('R-HANDLED', 1, ?, 50, 90, '["已经答复"]')`,
        args: [JSON.stringify([{ question: "已经回答？", options: [] }])],
      },
    ], "write");

    const snapshot = await overview(client);

    expect(snapshot.sections.todos).toHaveLength(3);
    expect(snapshot.sections.todos.map((item) => ({
      kind: item.kind,
      requirement: item.requirement,
      waitingSinceMs: item.waitingSinceMs,
      action: item.action,
    }))).toEqual([
      {
        kind: "reply",
        requirement: { id: "R-REPLY", title: "支付重试规则" },
        waitingSinceMs: 100,
        action: { label: "处理", href: expect.stringMatching(/R-REPLY/) },
      },
      {
        kind: "choice",
        requirement: { id: "R-CHOICE", title: "费用统计时区" },
        waitingSinceMs: 200,
        action: { label: "处理", href: expect.stringMatching(/R-CHOICE/) },
      },
      {
        kind: "approval",
        requirement: { id: "R-APPROVAL", title: "后台首屏" },
        waitingSinceMs: 300,
        action: { label: "处理", href: expect.stringMatching(/R-APPROVAL/) },
      },
    ]);
    expect(new Set(snapshot.sections.todos.map((item) => item.id)).size).toBe(3);
    expect(snapshot.sections.todos.some((item) => item.requirement.id === "R-HANDLED")).toBe(false);
  });

  it("@scenario S-R237511OV-01-todo excludes answered rounds even when an older unanswered-looking record exists", async () => {
    const client = await database();
    await client.batch([
      requirement({ id: "R-DONE", title: "已处理需求", state: "CLARIFY", createdAt: 1, updatedAt: 4 }),
      {
        sql: `INSERT INTO requirement_clarify_rounds
                (requirement_id, round, questions, asked_at, answered_at, answers)
              VALUES ('R-DONE', 1, '["旧问题"]', 2, 3, '["旧答案"]')`,
        args: [],
      },
    ], "write");

    expect((await overview(client)).sections.todos).toEqual([]);
  });

  it("@scenario S-R237511OV-01-active returns requirements and tasks by newest change with exact stage and running status", async () => {
    const client = await database();
    await client.batch([
      requirement({ id: "R-ACTIVE", title: "支付重试规则", state: "SOLUTION", createdAt: 1, updatedAt: 500 }),
      story({ id: "S-CODE", title: "重试退避", state: "CODE", phase: "CODE", createdAt: 2, updatedAt: 400 }),
      story({ id: "S-VERIFY", title: "异常归类", state: "VERIFY", phase: "VERIFY", createdAt: 3, updatedAt: 300 }),
      story({ id: "S-WAIT", title: "等待答复", state: "NEEDS_INPUT", phase: "CODE", stopReason: "blocking_question", createdAt: 4, updatedAt: 900 }),
      story({ id: "S-FAILED", title: "失败任务", state: "FAILED", phase: "VERIFY", createdAt: 5, updatedAt: 800 }),
      story({ id: "S-DONE", title: "完成任务", state: "DELIVERED", phase: "MERGE", createdAt: 6, updatedAt: 700 }),
    ], "write");

    const snapshot = await overview(client);

    expect(snapshot.sections.active.map((item) => ({
      id: item.id,
      type: item.type,
      name: item.name,
      stage: item.stage,
      status: item.status,
      changedAtMs: item.changedAtMs,
    }))).toEqual([
      { id: "R-ACTIVE", type: "requirement", name: "支付重试规则", stage: "SOLUTION", status: "running", changedAtMs: 500 },
      { id: "S-CODE", type: "task", name: "重试退避", stage: "CODE", status: "running", changedAtMs: 400 },
      { id: "S-VERIFY", type: "task", name: "异常归类", stage: "VERIFY", status: "running", changedAtMs: 300 },
    ]);
    expect(snapshot.summary.runningCount).toBe(3);
  });

  it("@scenario S-R237511OV-01-active does not classify waiting, failed or completed entities as running", async () => {
    const client = await database();
    await client.batch([
      requirement({ id: "R-WAIT", title: "等待需求", state: "HUMAN_PARKED", createdAt: 1, updatedAt: 6 }),
      requirement({ id: "R-FAILED", title: "失败需求", state: "FAILED", createdAt: 2, updatedAt: 5 }),
      requirement({ id: "R-DONE", title: "完成需求", state: "DONE", createdAt: 3, updatedAt: 4 }),
    ], "write");

    const snapshot = await overview(client);
    expect(snapshot.sections.active).toEqual([]);
    expect(snapshot.summary.runningCount).toBe(0);
  });

  it("@scenario S-R237511OV-01-failures returns current failures newest first with stage, reason and failure time", async () => {
    const client = await database();
    await client.batch([
      requirement({ id: "R-FAILED", title: "账单导出需求", state: "FAILED", createdAt: 1, updatedAt: 200 }),
      story({ id: "S-FAILED", title: "账单导出", state: "FAILED", phase: "VERIFY", createdAt: 2, updatedAt: 300 }),
      story({ id: "S-RECOVERED", title: "已经恢复", state: "CODE", phase: "CODE", createdAt: 3, updatedAt: 400 }),
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES ('requirement-failure', 0, 'R-FAILED', NULL, 'requirement.transition', 200, ?)`,
        args: [JSON.stringify({ from: "SOLUTION", to: "FAILED", reason: "方案无法形成" })],
      },
      {
        sql: `INSERT INTO phase_runs
                (run_id, card_id, phase, round, prompt_sha256, status, failure, started_at, ended_at)
              VALUES ('story-failure', 'S-FAILED', 'VERIFY', 1, ?, 'failed', '验收未通过', 250, 300)`,
        args: ["a".repeat(64)],
      },
      {
        sql: `INSERT INTO phase_runs
                (run_id, card_id, phase, round, prompt_sha256, status, failure, started_at, ended_at)
              VALUES ('old-failure', 'S-RECOVERED', 'SPECIFY', 1, ?, 'failed', '旧失败', 90, 100)`,
        args: ["b".repeat(64)],
      },
    ], "write");

    const snapshot = await overview(client);

    expect(snapshot.sections.failures.map((item) => ({
      id: item.id,
      type: item.type,
      name: item.name,
      stage: item.stage,
      status: item.status,
      reason: item.reason,
      failedAtMs: item.failedAtMs,
    }))).toEqual([
      { id: "S-FAILED", type: "task", name: "账单导出", stage: "VERIFY", status: "failed", reason: "验收未通过", failedAtMs: 300 },
      { id: "R-FAILED", type: "requirement", name: "账单导出需求", stage: "SOLUTION", status: "failed", reason: "方案无法形成", failedAtMs: 200 },
    ]);
    expect(snapshot.summary.failureCount).toBe(2);
  });

  it("@scenario S-R237511OV-01-failures excludes a recovered entity even when its failure history remains", async () => {
    const client = await database();
    await client.batch([
      story({ id: "S-RECOVERED", title: "已恢复任务", state: "CODE", phase: "CODE", createdAt: 1, updatedAt: 3 }),
      {
        sql: `INSERT INTO phase_runs
                (run_id, card_id, phase, round, prompt_sha256, status, failure, started_at, ended_at)
              VALUES ('old-failure', 'S-RECOVERED', 'SPECIFY', 1, ?, 'failed', '网络中断', 1, 2)`,
        args: ["c".repeat(64)],
      },
    ], "write");

    expect((await overview(client)).sections.failures).toEqual([]);
  });

  it("@scenario S-R237511OV-01-recent7d includes both ends of the rolling seven-day range and sorts later completions first", async () => {
    const client = await database();
    await client.batch([
      story({ id: "S-RECENT", title: "今天完成", state: "DELIVERED", phase: "MERGE", createdAt: 1, updatedAt: NOW }),
      requirement({ id: "R-BOUNDARY", title: "恰好七天", state: "DONE", createdAt: 2, updatedAt: RANGE_START }),
      story({ id: "S-OLD", title: "早于七天", state: "DELIVERED", phase: "MERGE", createdAt: 3, updatedAt: RANGE_START - 1 }),
      story({ id: "S-RUNNING", title: "尚未完成", state: "CODE", phase: "CODE", createdAt: 4, updatedAt: NOW - 1 }),
      requirement({ id: "R-FUTURE", title: "未来时间", state: "DONE", createdAt: 5, updatedAt: NOW + 1 }),
    ], "write");

    const snapshot = await overview(client);

    expect(snapshot.summary.range).toEqual({
      startInclusiveMs: RANGE_START,
      endInclusiveMs: NOW,
      timeZone: "Asia/Shanghai",
    });
    expect(snapshot.sections.completed.map((item) => ({
      id: item.id,
      type: item.type,
      name: item.name,
      status: item.status,
      completedAtMs: item.completedAtMs,
    }))).toEqual([
      { id: "S-RECENT", type: "task", name: "今天完成", status: "completed", completedAtMs: NOW },
      { id: "R-BOUNDARY", type: "requirement", name: "恰好七天", status: "completed", completedAtMs: RANGE_START },
    ]);
    expect(snapshot.summary.completedCount).toBe(2);
  });

  it("@scenario S-R237511OV-01-recent7d excludes a completion one millisecond before the boundary and every unfinished item", async () => {
    const client = await database();
    await client.batch([
      requirement({ id: "R-OLD", title: "范围外", state: "DONE", createdAt: 1, updatedAt: RANGE_START - 1 }),
      story({ id: "S-OPEN", title: "仍在运行", state: "VERIFY", phase: "VERIFY", createdAt: 2, updatedAt: NOW }),
    ], "write");

    const snapshot = await overview(client);
    expect(snapshot.sections.completed).toEqual([]);
    expect(snapshot.summary.completedCount).toBe(0);
  });

  it("@scenario S-R237511OV-01-costs reports seven-day counts and USD cost with range, time zone and continuing overrun", async () => {
    const client = await database();
    await client.batch([
      requirement({ id: "R-COST", title: "模型费用台账", state: "EXECUTING", createdAt: 1, updatedAt: NOW - 4 }),
      {
        sql: `INSERT INTO epics
                (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
              VALUES ('E-COST', 'page-E-COST', '费用批次', 'EXECUTING', 'R-COST', 1, 2)`,
        args: [],
      },
      story({ id: "S-COST", title: "费用投影", state: "CODE", phase: "CODE", epicId: "E-COST", createdAt: 2, updatedAt: NOW - 3 }),
      story({ id: "S-DONE", title: "已完成任务", state: "DELIVERED", phase: "MERGE", createdAt: 3, updatedAt: NOW - 2 }),
      story({ id: "S-FAILED", title: "失败任务", state: "FAILED", phase: "VERIFY", createdAt: 4, updatedAt: NOW - 1 }),
      {
        sql: `INSERT INTO phase_runs
                (run_id, card_id, phase, round, prompt_sha256, status, failure, started_at, ended_at)
              VALUES ('failed-run', 'S-FAILED', 'VERIFY', 1, ?, 'failed', '验收失败', ?, ?)`,
        args: ["d".repeat(64), NOW - 2, NOW - 1],
      },
      {
        sql: `INSERT INTO cost_entries
                (run_id, card_id, provider, model_id, cost_usd, ts)
              VALUES ('cost-1', 'S-COST', 'mock', 'mock-1', 12.4, ?),
                     ('cost-2', 'S-COST', 'mock', 'mock-1', 7.6, ?),
                     ('cost-old', 'S-COST', 'mock', 'mock-1', 99, ?)`,
        args: [NOW - 20, RANGE_START, RANGE_START - 1],
      },
      {
        sql: `INSERT INTO config_entries (key, value_json, updated_by, updated_at)
              VALUES ('cost.perCardUsdCeiling', '15', 'test', 1)`,
        args: [],
      },
    ], "write");

    const snapshot = await overview(client);

    expect(snapshot.summary).toMatchObject({
      range: { startInclusiveMs: RANGE_START, endInclusiveMs: NOW, timeZone: "Asia/Shanghai" },
      completedCount: 1,
      runningCount: 2,
      failureCount: 1,
      costUsd: 20,
    });
    expect(snapshot.summary.overruns).toEqual([{
      requirementId: "R-COST",
      requirementName: "模型费用台账",
      spentUsd: 20,
      limitUsd: 15,
      status: "over_limit",
      workContinues: true,
      costsHref: expect.stringMatching(/R-COST/),
    }]);
    expect(JSON.stringify(snapshot.summary.overruns)).not.toContain("paused");
    expect(JSON.stringify(snapshot.summary.overruns)).not.toContain("已暂停");
  });

  it("@scenario S-R237511OV-01-costs does not count cost before the inclusive seven-day boundary or flag spend equal to the limit", async () => {
    const client = await database();
    await client.batch([
      requirement({ id: "R-COST", title: "费用刚好到限", state: "EXECUTING", createdAt: 1, updatedAt: 2 }),
      {
        sql: `INSERT INTO epics
                (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
              VALUES ('E-COST', 'page-E-COST', '费用批次', 'EXECUTING', 'R-COST', 1, 2)`,
        args: [],
      },
      story({ id: "S-COST", title: "费用任务", state: "CODE", phase: "CODE", epicId: "E-COST", createdAt: 1, updatedAt: 2 }),
      {
        sql: `INSERT INTO cost_entries (run_id, card_id, provider, model_id, cost_usd, ts)
              VALUES ('inside', 'S-COST', 'mock', 'mock-1', 15, ?),
                     ('outside', 'S-COST', 'mock', 'mock-1', 1, ?)`,
        args: [RANGE_START, RANGE_START - 1],
      },
      {
        sql: `INSERT INTO config_entries (key, value_json, updated_by, updated_at)
              VALUES ('cost.perCardUsdCeiling', '15', 'test', 1)`,
        args: [],
      },
    ], "write");

    const snapshot = await overview(client);
    expect(snapshot.summary.costUsd).toBe(15);
    expect(snapshot.summary.overruns).toEqual([]);
  });
});

function refreshSnapshot(revision: string, stage: "CODE" | "VERIFY", generatedAtMs: number): OverviewSnapshot {
  return {
    revision,
    generatedAtMs,
    contentState: { kind: "ready" },
    sections: {
      todos: [],
      active: [{
        id: "S-REFRESH",
        type: "task",
        name: "重试退避",
        stage,
        status: "running",
        changedAtMs: generatedAtMs,
        detailHref: "/detail/S-REFRESH",
      }],
      failures: [],
      completed: [],
    },
    summary: {
      range: { startInclusiveMs: generatedAtMs - 7 * DAY_MS, endInclusiveMs: generatedAtMs, timeZone: "Asia/Shanghai" },
      completedCount: 0,
      runningCount: 1,
      failureCount: 0,
      costUsd: 0,
      overruns: [],
    },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function controller(input: {
  transport: OverviewSnapshotTransport;
  scheduled: Array<{ delayMs: number; task: () => void }>;
}): Promise<OverviewRefreshController> {
  const contract = await import("./overview-contract.js");
  expect(contract.createOverviewRefreshController).toEqual(expect.any(Function));
  return contract.createOverviewRefreshController({
    transport: input.transport,
    timeZone: "Asia/Shanghai",
    refreshIntervalMs: 30000,
    schedule: (delayMs, task) => {
      const handle = { delayMs, task };
      input.scheduled.push(handle);
      return handle;
    },
    cancel: vi.fn(),
  });
}

describe("overview foreground refresh", () => {
  it("@scenario S-R237511OV-01-refresh replaces CODE with VERIFY within the scheduled interval while retaining readable content", async () => {
    const first = deferred<OverviewSnapshot>();
    const second = deferred<OverviewSnapshot>();
    const fetchOverview = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const scheduled: Array<{ delayMs: number; task: () => void }> = [];
    const refresh = await controller({ transport: { fetchOverview }, scheduled });

    expect(refresh.current()).toEqual({ kind: "loading", scope: "todos_active_failures_completed_7d" });
    refresh.start();
    expect(fetchOverview).toHaveBeenCalledTimes(1);
    first.resolve(refreshSnapshot("1", "CODE", NOW));
    await vi.waitFor(() => expect(refresh.current()).toMatchObject({ kind: "content", refreshing: false }));
    expect(scheduled.at(-1)?.delayMs).toBe(30000);

    scheduled.at(-1)?.task();
    expect(refresh.current()).toMatchObject({
      kind: "content",
      refreshing: true,
      snapshot: { sections: { active: [{ id: "S-REFRESH", stage: "CODE" }] } },
    });
    second.resolve(refreshSnapshot("2", "VERIFY", NOW + 30000));
    await vi.waitFor(() => expect(refresh.current()).toMatchObject({
      kind: "content",
      refreshing: false,
      snapshot: { generatedAtMs: NOW + 30000, sections: { active: [{ id: "S-REFRESH", stage: "VERIFY" }] } },
    }));
    const state = refresh.current();
    expect(state.kind === "content" ? state.snapshot.sections.active : []).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain('"stage":"CODE"');
  });

  it("@scenario S-R237511OV-01-refresh never overlaps requests, retains the prior snapshot on failure and retries immediately on demand", async () => {
    const initial = refreshSnapshot("1", "CODE", NOW);
    const pending = deferred<OverviewSnapshot>();
    const retry = deferred<OverviewSnapshot>();
    const fetchOverview = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(retry.promise);
    const scheduled: Array<{ delayMs: number; task: () => void }> = [];
    const refresh = await controller({ transport: { fetchOverview }, scheduled });
    refresh.start();
    await vi.waitFor(() => expect(refresh.current()).toMatchObject({ kind: "content" }));

    scheduled.at(-1)?.task();
    scheduled.at(-1)?.task();
    refresh.visibilityChanged(true);
    expect(fetchOverview).toHaveBeenCalledTimes(2);
    pending.reject(new Error("network unavailable"));
    await vi.waitFor(() => expect(refresh.current()).toMatchObject({
      kind: "error",
      retryable: true,
      previous: { revision: "1", sections: { active: [{ stage: "CODE" }] } },
    }));

    refresh.retry();
    expect(fetchOverview).toHaveBeenCalledTimes(3);
    retry.resolve(refreshSnapshot("2", "VERIFY", NOW + 30000));
    await vi.waitFor(() => expect(refresh.current()).toMatchObject({
      kind: "content",
      snapshot: { revision: "2", sections: { active: [{ stage: "VERIFY" }] } },
    }));
  });
});
