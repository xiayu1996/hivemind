import { describe, expect, it } from "vitest";
import { createConsoleServer, listenConsole, type ConsoleDataSource } from "./server.js";

const data: ConsoleDataSource = {
  nodes: async () => [{ hostId: "windows-1", status: "healthy" }],
  tasks: async () => [{ id: "story-1", events: [{ type: "turn_end" }], traceHtml: "<div>trace</div>" }],
  costs: async () => [{ runId: "run-1", costUsd: 0.1 }],
  config: async () => [{ key: "pipeline.maxRounds", value: 6 }],
  stats: async () => ({ footprintDeviation: { stories: 0, deviationRate: 0, unpredictedStoryRate: 0, perStory: [] } }),
};

describe("read-only console", () => {
  it("serves four real-data API views and health", async () => {
    const app = await createConsoleServer(data, { serveUi: false });
    await expect(app.inject({ method: "GET", url: "/health" }).then((response) => response.json())).resolves.toEqual({ status: "ok" });
    for (const route of ["nodes", "tasks", "costs", "config"]) {
      const response = await app.inject({ method: "GET", url: `/api/${route}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(1);
    }
    await app.close();
  });

  it("rejects every write method including Bull Board mutations", async () => {
    const app = await createConsoleServer(data, { serveUi: false });
    const response = await app.inject({ method: "POST", url: "/api/config", payload: { value: 1 } });
    expect(response.statusCode).toBe(405);
    await app.close();
  });

  it("refuses a public wildcard bind", async () => {
    const app = await createConsoleServer(data, { serveUi: false });
    await expect(listenConsole(app, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/public wildcard/);
    await app.close();
  });

  it("mounts Bull Board under the queue path", async () => {
    const app = await createConsoleServer(data, { serveUi: false });
    const response = await app.inject({ method: "GET", url: "/queues" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Bull Dashboard");
    await app.close();
  });
});
