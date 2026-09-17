import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";
import type { TaskExecutionDetailDataSource } from "./task-execution-detail.js";

async function executionSource() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  await client.batch([
    `INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at)
       VALUES ('S-TRACE02-01', 'page-target', 'Round-by-round execution detail', 'Show rounds', 'CODE', 1, 400)`,
    `INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at)
       VALUES ('S-OTHER-01', 'page-other', 'Other task', 'Do not show this task', 'VERIFY', 1, 500)`,
    {
      sql: `INSERT INTO phase_runs
              (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
            VALUES ('target-1', 'S-TRACE02-01', 'VERIFY', 1, ?, 'completed', 100, 110)`,
      args: ["a".repeat(64)],
    },
    {
      sql: `INSERT INTO phase_runs
              (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
            VALUES ('target-2', 'S-TRACE02-01', 'VERIFY', 2, ?, 'completed', 200, 210)`,
      args: ["b".repeat(64)],
    },
    {
      sql: `INSERT INTO phase_runs
              (run_id, card_id, phase, round, prompt_sha256, status, started_at)
            VALUES ('target-3', 'S-TRACE02-01', 'CODE', 3, ?, 'running', 300)`,
      args: ["c".repeat(64)],
    },
    {
      sql: `INSERT INTO phase_runs
              (run_id, card_id, phase, round, prompt_sha256, status, started_at, ended_at)
            VALUES ('other-1', 'S-OTHER-01', 'VERIFY', 1, ?, 'completed', 120, 130)`,
      args: ["d".repeat(64)],
    },
    `INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at)
       VALUES ('target-1', 'S-TRACE02-01', 'VERIFY', 1, 'result', 'round-one-output', 105)`,
    `INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at)
       VALUES ('target-2', 'S-TRACE02-01', 'VERIFY', 2, 'result', 'round-two-output', 205)`,
    `INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at)
       VALUES ('target-3', 'S-TRACE02-01', 'CODE', 3, 'progress', 'round-three-latest-progress', 305)`,
    `INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at)
       VALUES ('other-1', 'S-OTHER-01', 'VERIFY', 1, 'result', 'other-task-output', 125)`,
    `INSERT INTO verify_records
       (card_id, round, code_session_id, verify_session_id, verdict, failed_scenarios, created_at)
       VALUES ('S-TRACE02-01', 1, 'code-1', 'verify-1', 'accepted', '[]', 110)`,
    `INSERT INTO verify_records
       (card_id, round, code_session_id, verify_session_id, verdict, failed_scenarios, created_at)
       VALUES ('S-TRACE02-01', 2, 'code-2', 'verify-2', 'rejected', '["S-TRACE02-01-navigation"]', 210)`,
    {
      sql: `INSERT INTO phase_artifacts (run_id, card_id, phase, round, kind, body, created_at)
            VALUES ('target-2', 'S-TRACE02-01', 'VERIFY', 2, 'verification', ?, 210)`,
      args: [JSON.stringify({
        verdict: "rejected",
        failedScenarios: ["S-TRACE02-01-navigation"],
        reasons: [{
          scenarioId: "S-TRACE02-01-navigation",
          reason: "The detail included records from another task",
        }],
        validationErrors: [],
      })],
    },
  ], "write");
  return { client, source: new LibsqlConsoleDataSource(client, async () => []) };
}

function detailReader(source: LibsqlConsoleDataSource): TaskExecutionDetailDataSource["taskExecutionDetail"] {
  const read = (source as unknown as Partial<TaskExecutionDetailDataSource>).taskExecutionDetail;
  expect(read).toBeTypeOf("function");
  return read as TaskExecutionDetailDataSource["taskExecutionDetail"];
}

describe("task execution detail read boundary", () => {
  it("@scenario S-TRACE02-01-timeline reads every persisted round once in ascending order with its process, output and result", async () => {
    const { client, source } = await executionSource();
    try {
      const detail = await detailReader(source).call(source, "S-TRACE02-01");

      expect(detail).toMatchObject({
        taskId: "S-TRACE02-01",
        taskName: "Round-by-round execution detail",
      });
      expect(detail?.rounds.map((round) => round.round)).toEqual([1, 2, 3]);
      expect(detail?.rounds.map((round) => round.process.map((step) => step.phase))).toEqual([
        ["VERIFY"],
        ["VERIFY"],
        ["CODE"],
      ]);
      expect(detail?.rounds.map((round) => round.outputs.map((output) => output.content))).toEqual([
        ["round-one-output"],
        ["round-two-output", expect.stringContaining("The detail included records from another task")],
        ["round-three-latest-progress"],
      ]);
    } finally {
      client.close();
    }
  });

  it("@scenario S-TRACE02-01-timeline excludes every process, output and result owned by another task", async () => {
    const { client, source } = await executionSource();
    try {
      const detail = await detailReader(source).call(source, "S-TRACE02-01");
      const serialized = JSON.stringify(detail);

      expect(serialized).not.toContain("S-OTHER-01");
      expect(serialized).not.toContain("Other task");
      expect(serialized).not.toContain("other-task-output");
      expect(detail?.rounds).toHaveLength(3);
    } finally {
      client.close();
    }
  });

  it("@scenario S-TRACE02-01-statuses derives terminal statuses and preserves the actual persisted failure reason", async () => {
    const { client, source } = await executionSource();
    try {
      const detail = await detailReader(source).call(source, "S-TRACE02-01");

      expect(detail?.rounds.map((round) => round.status)).toEqual(["completed", "failed", "running"]);
      expect(detail?.rounds[1]).toMatchObject({
        failureReason: "The detail included records from another task",
      });
      expect(detail?.rounds[2]).toMatchObject({
        currentResult: "round-three-latest-progress",
      });
    } finally {
      client.close();
    }
  });

  it("@scenario S-TRACE02-01-statuses omits failure reasons from completed and running rounds", async () => {
    const { client, source } = await executionSource();
    try {
      const detail = await detailReader(source).call(source, "S-TRACE02-01");

      expect("failureReason" in (detail?.rounds[0] ?? {})).toBe(false);
      expect("failureReason" in (detail?.rounds[2] ?? {})).toBe(false);
      expect(detail?.rounds.filter((round) => "failureReason" in round)).toHaveLength(1);
    } finally {
      client.close();
    }
  });
});

describe("task execution detail HTTP endpoint", () => {
  const emptyDetail = {
    taskId: "S-TRACE02-01",
    taskName: "Round-by-round execution detail",
    rounds: [],
    observedAt: 900,
  } as const;

  function dataSource(): ConsoleDataSource {
    return {
      nodes: async () => [],
      tasks: async () => [{ id: emptyDetail.taskId, title: emptyDetail.taskName }],
      costs: async () => [],
      config: async () => [],
      stats: async () => ({}),
      providers: async () => [],
      queue: async () => ({ waiting: [], running: [], providerSlots: [] }),
      taskExecutionDetail: async (taskId) => taskId === emptyDetail.taskId ? emptyDetail : null,
    };
  }

  it("@scenario S-TRACE02-01-empty returns the task identity and an empty round list without fabricated content", async () => {
    const app = await createConsoleServer(dataSource(), { serveUi: false });
    try {
      const response = await app.inject({ method: "GET", url: "/api/tasks/S-TRACE02-01" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(emptyDetail);
      expect(response.body).not.toContain("failureReason");
      expect(response.body).not.toContain("outputs");
      expect(response.body).not.toContain("round-one");
    } finally {
      await app.close();
    }
  });

  it("@scenario S-TRACE02-01-empty returns task_not_found instead of an empty or invented task for an unknown identifier", async () => {
    const app = await createConsoleServer(dataSource(), { serveUi: false });
    try {
      const response = await app.inject({ method: "GET", url: "/api/tasks/S-MISSING-01" });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "task_not_found", taskId: "S-MISSING-01" });
    } finally {
      await app.close();
    }
  });
});
