import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { CostLedger, type CostRecordedEvent } from "./cost-ledger.js";

describe("CostLedger", () => {
  it("records pi's four exclusive buckets and self-reported cost", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const emitted: CostRecordedEvent[] = [];
    const ledger = new CostLedger(client, { emit: async (event) => { emitted.push(event); } }, () => 123);
    await ledger.record({
      runId: "run-1",
      cardId: "card-1",
      phase: "CODE",
      purpose: "implementation",
      tier: "middle",
      provider: "mock",
      modelId: "mock-1",
      hostId: "host-1",
    }, { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, reasoning: 4, costUsd: 0.125 });

    const row = (await client.execute("SELECT * FROM cost_entries")).rows[0]!;
    expect(row).toMatchObject({
      uncached_input_tokens: 11,
      output_tokens: 7,
      cache_read_tokens: 3,
      cache_write_tokens: 2,
      reasoning_tokens: 4,
      cost_usd: 0.125,
      model_id: "mock-1",
      host_id: "host-1",
    });
    expect(emitted[0]?.data.costUsd).toBe(0.125);
    client.close();
  });

  it("rejects overlapping reasoning and invalid buckets before storage", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const execute = vi.spyOn(client, "execute");
    const ledger = new CostLedger(client);
    await expect(ledger.record({ runId: "r", provider: "p", modelId: "m" }, {
      input: 0, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 3, costUsd: 0,
    })).rejects.toThrow(/reasoning/);
    expect(execute).not.toHaveBeenCalled();
    client.close();
  });
});
