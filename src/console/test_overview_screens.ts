import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import {
  createLibsqlOverviewReader,
  createOverviewRefreshController,
  type OverviewSnapshot,
} from "./overview-contract.js";

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const clients: Client[] = [];

async function database(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  await migrate(client);
  return client;
}

function readySnapshot(): OverviewSnapshot {
  return {
    revision: "1",
    generatedAtMs: NOW,
    contentState: { kind: "ready" },
    sections: { todos: [], active: [], failures: [], completed: [] },
    summary: {
      range: { startInclusiveMs: NOW - 7 * DAY_MS, endInclusiveMs: NOW, timeZone: "Asia/Shanghai" },
      completedCount: 0,
      runningCount: 0,
      failureCount: 0,
      costUsd: 0,
      overruns: [],
    },
  };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
});

/**
 * The four states a person can open the overview into. The page-level wording
 * is judged in the browser; what CODE decides is the read that produces each
 * state, and this file is where that decision is pinned.
 */
describe("overview reading states", () => {
  it("@scenario S-R237511OV-01-states reads an empty result before anything is running", async () => {
    const snapshot = await createLibsqlOverviewReader(await database())
      .readOverview({ nowMs: NOW, timeZone: "Asia/Shanghai" });

    expect(snapshot.contentState).toEqual({ kind: "empty" });
    expect(snapshot.sections).toEqual({ todos: [], active: [], failures: [], completed: [] });
  });

  it("@scenario S-R237511OV-01-states reads a ready result once one running item exists", async () => {
    const client = await database();
    await client.execute(`INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
      VALUES ('R-ONE', 'page-R-ONE', '首屏', 'CLARIFY', 'request', 1, 2)`);

    const snapshot = await createLibsqlOverviewReader(client)
      .readOverview({ nowMs: NOW, timeZone: "Asia/Shanghai" });

    expect(snapshot.contentState).toEqual({ kind: "ready" });
    expect(snapshot.sections.active).toHaveLength(1);
  });

  it("@scenario S-R237511OV-01-states keeps the reading state, then recovers from a failed read on demand", async () => {
    let attempts = 0;
    const controller = createOverviewRefreshController({
      transport: {
        fetchOverview: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("network unavailable");
          return readySnapshot();
        },
      },
      timeZone: "Asia/Shanghai",
      refreshIntervalMs: 30000,
      schedule: (_delayMs, task) => task,
      cancel: () => {},
    });

    expect(controller.current()).toEqual({ kind: "loading", scope: "todos_active_failures_completed_7d" });
    controller.start();
    await vi.waitFor(() => expect(controller.current()).toEqual({ kind: "error", retryable: true }));

    controller.retry();
    await vi.waitFor(() => expect(controller.current()).toMatchObject({ kind: "content", refreshing: false }));
    expect(attempts).toBe(2);
  });
});

/**
 * The viewport split is a browser judgement; the read has to hand both
 * viewports the same four sections in the same fixed order, with the range and
 * time zone the summary states, or no layout can be right.
 */
describe("overview layout contract", () => {
  it("@scenario S-R237511OV-01-responsive keeps every section in the fixed reading order in one snapshot", async () => {
    const snapshot = await createLibsqlOverviewReader(await database())
      .readOverview({ nowMs: NOW, timeZone: "Asia/Shanghai" });

    expect(Object.keys(snapshot.sections)).toEqual(["todos", "active", "failures", "completed"]);
    expect(snapshot.summary.range).toEqual({
      startInclusiveMs: NOW - 7 * DAY_MS,
      endInclusiveMs: NOW,
      timeZone: "Asia/Shanghai",
    });
    expect(snapshot.generatedAtMs).toBe(NOW);
  });
});
