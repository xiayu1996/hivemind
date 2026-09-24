import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlConsoleDataSource } from "./libsql-data-source.js";

describe("LibsqlConsoleDataSource", () => {
  it("reads task timelines, costs, config and live node snapshots", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.batch([
      "INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at) VALUES ('s1','p1','Story','Requirement','CODE',1,2)",
      "INSERT INTO event_log (run_id, seq, card_id, type, ts, data) VALUES ('r1',0,'s1','turn_start',3,'{\"turn\":1}')",
      "INSERT INTO cost_entries (run_id, provider, model_id, cost_usd, ts) VALUES ('r1','mock','mock-1',0.1,4)",
      "INSERT INTO config_entries (key, value_json, updated_by, updated_at) VALUES ('sample','6','test',5)",
    ], "write");
    const source = new LibsqlConsoleDataSource(client, async () => [{ hostId: "host-1" }]);
    await expect(source.nodes()).resolves.toEqual([{ hostId: "host-1" }]);
    await expect(source.tasks()).resolves.toMatchObject([{
      id: "s1",
      events: [{ type: "turn_start", data: { turn: 1 } }],
      traceHtml: expect.stringContaining("turn_start"),
    }]);
    await expect(source.costs()).resolves.toMatchObject([{ run_id: "r1", cost_usd: 0.1 }]);
    await expect(source.config()).resolves.toMatchObject([{ key: "sample", value: 6 }]);
    client.close();
  });
});
