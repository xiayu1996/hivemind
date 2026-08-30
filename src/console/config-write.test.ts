import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { ConsoleConfigWriter } from "./config-writer.js";
import { createConsoleServer, type ConsoleDataSource } from "./server.js";

const data: ConsoleDataSource = {
  nodes: async () => [],
  tasks: async () => [],
  costs: async () => [],
  config: async () => [],
  stats: async () => ({}),
  providers: async () => [],
};

describe("M2-13 console configuration write plane", () => {
  let client: ReturnType<typeof createClient>;
  let writer: ConsoleConfigWriter;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    writer = new ConsoleConfigWriter(await ConfigStore.load(client), client, () => 500);
  });

  afterEach(() => client.close());

  async function server() {
    return createConsoleServer(data, { serveUi: false, configWriter: writer });
  }

  it("describes every key with the schema a form can be generated from", async () => {
    const app = await server();

    const response = await app.inject({ method: "GET", url: "/api/config/schema" });
    const keys = response.json() as Array<{ key: string; schema: unknown; dangerous: boolean; overridden: boolean }>;

    const rounds = keys.find((entry) => entry.key === "retry.maxInnerLoopRounds");
    expect(rounds).toMatchObject({ dangerous: false, overridden: false, value: 6, scope: "global", reload: "hot" });
    expect(JSON.stringify(rounds?.schema)).toContain("integer");
    expect(keys.some((entry) => entry.dangerous)).toBe(true);
    await app.close();
  });

  it("applies a change, records it, and shows it on the next read", async () => {
    const app = await server();

    const response = await app.inject({
      method: "POST",
      url: "/api/config/value",
      payload: { key: "retry.maxInnerLoopRounds", value: 4, updatedBy: "ryan" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ key: "retry.maxInnerLoopRounds", previous: 6, next: 4, version: 1 });
    const events = (await client.execute("SELECT type, data FROM event_log WHERE type = 'config.changed'")).rows;
    expect(events).toHaveLength(1);
    expect(String(events[0]?.data)).toContain("ryan");
    await app.close();
  });

  it("refuses an invalid value instead of storing it", async () => {
    const app = await server();

    const response = await app.inject({
      method: "POST",
      url: "/api/config/value",
      payload: { key: "retry.maxInnerLoopRounds", value: -1, updatedBy: "ryan" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("retry.maxInnerLoopRounds") });
    await app.close();
  });

  it("makes a high-risk key take a second, deliberate answer", async () => {
    const app = await server();
    const payload = { key: "alert.requireOutOfBandChannel", value: false, updatedBy: "ryan" };

    const refused = await app.inject({ method: "POST", url: "/api/config/value", payload });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: expect.stringContaining("high-risk") });

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/config/value",
      payload: { ...payload, confirm: true },
    });
    expect(confirmed.statusCode).toBe(200);
    await app.close();
  });

  it("rolls a key back to the value it held before", async () => {
    const app = await server();
    const key = "retry.maxInnerLoopRounds";
    await app.inject({ method: "POST", url: "/api/config/value", payload: { key, value: 4, updatedBy: "ryan" } });
    await app.inject({ method: "POST", url: "/api/config/value", payload: { key, value: 2, updatedBy: "ryan" } });

    const response = await app.inject({
      method: "POST",
      url: "/api/config/rollback",
      payload: { key, version: 1, updatedBy: "ryan" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ previous: 2, next: 4 });
    const history = await app.inject({ method: "GET", url: `/api/config/history?key=${encodeURIComponent(key)}` });
    expect(history.json()).toHaveLength(3);
    await app.close();
  });

  it("still refuses every other write", async () => {
    const app = await server();

    expect((await app.inject({ method: "POST", url: "/api/tasks", payload: {} })).statusCode).toBe(405);
    expect((await app.inject({ method: "DELETE", url: "/api/config/value" })).statusCode).toBe(405);
    await app.close();
  });

  it("keeps the console read-only when no writer is wired in", async () => {
    const app = await createConsoleServer(data, { serveUi: false });

    expect((await app.inject({ method: "GET", url: "/api/config/schema" })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST",
      url: "/api/config/value",
      payload: { key: "retry.maxInnerLoopRounds", value: 4, updatedBy: "ryan" },
    })).statusCode).toBe(405);
    await app.close();
  });
});
