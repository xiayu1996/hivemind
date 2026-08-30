import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";

describe("M2-19 provider health on the console", () => {
  it("reads every provider's breaker state with its window and last error", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      `INSERT INTO provider_health (provider, state, consecutive_failures, opened_at, retry_at, needs_human, last_error_class, last_error, updated_at)
         VALUES ('openai-codex', 'open', 1, 100, 2900, 0, 'QUOTA', 'You have hit your ChatGPT usage limit.', 100)`,
      `INSERT INTO provider_health (provider, state, consecutive_failures, needs_human, updated_at)
         VALUES ('zai-coding-cn', 'closed', 0, 0, 120)`,
    ], "write");
    const source = new LibsqlConsoleDataSource(client, async () => []);

    await expect(source.providers()).resolves.toMatchObject([
      { provider: "openai-codex", state: "open", retry_at: 2900, last_error_class: "QUOTA" },
      { provider: "zai-coding-cn", state: "closed" },
    ]);
    client.close();
  });

  it("serves the provider view read-only", async () => {
    const data: ConsoleDataSource = {
      nodes: async () => [],
      tasks: async () => [],
      costs: async () => [],
      config: async () => [],
      stats: async () => ({}),
      providers: async () => [{ provider: "openai-codex", state: "closed" }],
    };
    const app = await createConsoleServer(data, { serveUi: false });

    const response = await app.inject({ method: "GET", url: "/api/providers" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{ provider: "openai-codex", state: "closed" }]);
    expect((await app.inject({ method: "POST", url: "/api/providers" })).statusCode).toBe(405);
    await app.close();
  });
});
