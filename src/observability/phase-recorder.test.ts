import { createClient } from "@libsql/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { parseCanonicalLog, rebuildProviderPayload, validateCoordinates } from "./canonical-log.js";
import { LibsqlPhaseRecorder } from "./phase-recorder.js";

describe("LibsqlPhaseRecorder", () => {
  it("round-trips exact provider payloads and records RPC events and cost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hivemind-phase-recorder-"));
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const payloads = [
      { model: "mock-1", messages: [{ role: "user", content: "first" }], tools: [] },
      { model: "mock-1", messages: [{ role: "user", content: "second" }], tools: [{ name: "read" }] },
    ];
    const recorder = new LibsqlPhaseRecorder(client, {
      evidenceRoot: directory,
      provider: "mock",
      modelId: "mock-1",
    }, () => 100);
    await recorder.record({
      runId: "run-1",
      cardId: "card-1",
      phase: "CODE",
      messages: [
        { role: "assistant", usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 50 } },
        { role: "toolResult", content: [] },
        {
          role: "assistant",
          usage: { input: 2000, cacheRead: 0, cacheWrite: 0, output: 20 },
          diagnostics: [{ kind: "provider_transport_failure" }],
        },
        { role: "assistant", content: "done", usage: { input: 100, cacheRead: 3072, cacheWrite: 0, output: 10 } },
      ],
      providerPayloads: payloads,
      result: {
        settled: true,
        failure: null,
        usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 1, costUsd: 0.05 },
        events: [{ type: "agent_settled" }],
      },
    });

    const canonical = parseCanonicalLog(await readFile(join(directory, "run-1", "run-events.jsonl"), "utf8"));
    expect(rebuildProviderPayload(canonical)).toEqual(payloads[1]);
    expect(() => validateCoordinates(canonical)).not.toThrow();
    const cost = await client.execute("SELECT provider, model_id, cost_usd FROM cost_entries");
    expect(cost.rows).toMatchObject([{ provider: "mock", model_id: "mock-1", cost_usd: 0.05 }]);
    const events = await client.execute("SELECT type FROM event_log WHERE run_id = 'run-1'");
    expect(events.rows).toMatchObject([{ type: "rpc.agent_settled" }]);

    // The second turn was sent to a cold shard: its whole previous context is a loss.
    const turns = await client.execute("SELECT turn, cache_read_tokens, cache_loss_tokens FROM turn_usage ORDER BY turn");
    expect(turns.rows).toMatchObject([
      { turn: 1, cache_read_tokens: 0, cache_loss_tokens: 0 },
      { turn: 2, cache_read_tokens: 0, cache_loss_tokens: 1050 },
      { turn: 3, cache_read_tokens: 3072, cache_loss_tokens: 0 },
    ]);
    const analysis = canonical.find((event) => event.type === "cache.analysis");
    expect(analysis?.data).toMatchObject({ turns: 3, lostTokens: 1050, losses: [{ turn: 2 }] });
    const diagnostics = canonical.filter((event) => event.type === "provider/diagnostics");
    expect(diagnostics.map((event) => event.data)).toEqual([
      { turn: 2, diagnostics: [{ kind: "provider_transport_failure" }] },
    ]);
    client.close();
    await rm(directory, { recursive: true, force: true });
  });
});
