import { describe, expect, it, vi } from "vitest";
import { createConsoleServer, listenConsole, type ConsoleDataSource } from "./server.js";
import { createConsoleAccessPage } from "./access-control.js";

const data: ConsoleDataSource = {
  readOverview: async (query) => ({
    revision: "1",
    generatedAtMs: query.nowMs,
    contentState: { kind: "ready" },
    sections: { todos: [], active: [], failures: [], completed: [] },
    summary: {
      range: {
        startInclusiveMs: query.nowMs - 7 * 24 * 60 * 60 * 1000,
        endInclusiveMs: query.nowMs,
        timeZone: query.timeZone,
      },
      completedCount: 0,
      runningCount: 0,
      failureCount: 0,
      costUsd: 0,
      overruns: [],
    },
  }),
  nodes: async () => [{ hostId: "windows-1", status: "healthy" }],
  tasks: async () => [{ id: "story-1", events: [{ type: "turn_end" }], traceHtml: "<div>trace</div>" }],
  costs: async () => [{ runId: "run-1", costUsd: 0.1 }],
  config: async () => [{ key: "pipeline.maxRounds", value: 6 }],
  stats: async () => ({ footprintDeviation: { stories: 0, deviationRate: 0, unpredictedStoryRate: 0, perStory: [] } }),
  providers: async () => [{ provider: "openai-codex", state: "closed" }],
  queue: async () => ({ waiting: [{ id: "story-2" }], running: [], providerSlots: [] }),
};

const openAccess = {
  accessPolicy: { authorize: () => ({ allowed: true as const, matchedNetwork: "0.0.0.0/0" }) },
  accessPage: createConsoleAccessPage(),
};

describe("read-only console", () => {
  it("serves four real-data API views and health", async () => {
    const app = await createConsoleServer(data, { serveUi: false, ...openAccess });
    await expect(app.inject({ method: "GET", url: "/health" }).then((response) => response.json())).resolves.toEqual({ status: "ok" });
    for (const route of ["nodes", "tasks", "costs", "config", "providers"]) {
      const response = await app.inject({ method: "GET", url: `/api/${route}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(1);
    }
    await app.close();
  });

  it("@scenario S-R237511OV-01-active serves one overview snapshot with a validated time zone and server time", async () => {
    const readOverview = vi.fn(data.readOverview);
    const app = await createConsoleServer({ ...data, readOverview }, { serveUi: false, ...openAccess });
    const before = Date.now();

    const response = await app.inject({ method: "GET", url: "/api/overview?timeZone=Asia%2FShanghai" });

    expect(response.statusCode).toBe(200);
    expect(readOverview).toHaveBeenCalledOnce();
    expect(readOverview).toHaveBeenCalledWith({
      nowMs: expect.any(Number),
      timeZone: "Asia/Shanghai",
    });
    const query = readOverview.mock.calls[0]?.[0];
    expect(query?.nowMs).toBeGreaterThanOrEqual(before);
    expect(query?.nowMs).toBeLessThanOrEqual(Date.now());
    expect(response.json()).toMatchObject({
      generatedAtMs: query?.nowMs,
      summary: { range: { timeZone: "Asia/Shanghai" } },
    });
    await app.close();
  });

  it("@scenario S-R237511OV-01-active rejects an invalid time zone before reading overview data", async () => {
    const readOverview = vi.fn(data.readOverview);
    const app = await createConsoleServer({ ...data, readOverview }, { serveUi: false, ...openAccess });

    const response = await app.inject({ method: "GET", url: "/api/overview?timeZone=not-a-zone" });

    expect(response.statusCode).toBe(400);
    expect(readOverview).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects every write method", async () => {
    const app = await createConsoleServer(data, { serveUi: false, ...openAccess });
    const response = await app.inject({ method: "POST", url: "/api/config", payload: { value: 1 } });
    expect(response.statusCode).toBe(405);
    await app.close();
  });

  it("refuses a public wildcard bind", async () => {
    const app = await createConsoleServer(data, { serveUi: false, ...openAccess });
    await expect(listenConsole(app, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/public wildcard/);
    await app.close();
  });

  it("serves the queue from the central store rather than a broker dashboard", async () => {
    const app = await createConsoleServer(data, { serveUi: false, ...openAccess });
    const response = await app.inject({ method: "GET", url: "/api/queue" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ waiting: [{ id: "story-2" }] });
    await app.close();
  });
});
