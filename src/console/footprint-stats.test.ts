import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";

describe("S-M2-07-stats footprint deviation on the statistics page", () => {
  it("summarizes only the Stories whose actual footprint was recorded at merge", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      `INSERT INTO stories (id, notion_page_id, title, requirement, state, predicted_footprint, actual_footprint, created_at, updated_at)
         VALUES ('s1','p1','Merged','Requirement','DELIVERED','["src/vcs"]','["src/vcs","src/console"]',1,2)`,
      `INSERT INTO stories (id, notion_page_id, title, requirement, state, predicted_footprint, created_at, updated_at)
         VALUES ('s2','p2','In flight','Requirement','CODE','["src/notion"]',1,2)`,
    ], "write");
    const source = new LibsqlConsoleDataSource(client, async () => []);

    await expect(source.stats()).resolves.toEqual({
      footprintDeviation: {
        stories: 1,
        deviationRate: 1 / 3,
        unpredictedStoryRate: 1,
        perStory: [{ storyId: "s1", unpredicted: ["src/console"], unused: [], deviationRate: 1 / 3 }],
      },
    });
    client.close();
  });

  it("serves the summary under the statistics API and route", async () => {
    const data: ConsoleDataSource = {
      nodes: async () => [],
      tasks: async () => [],
      costs: async () => [],
      config: async () => [],
      stats: async () => ({ footprintDeviation: { stories: 0, deviationRate: 0, unpredictedStoryRate: 0, perStory: [] } }),
      providers: async () => [],
    };
    const app = await createConsoleServer(data, { serveUi: false });
    const response = await app.inject({ method: "GET", url: "/api/stats" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ footprintDeviation: { stories: 0 } });
    await app.close();
  });
});
