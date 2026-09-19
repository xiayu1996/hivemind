import { createClient } from "@libsql/client";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPackedText } from "./packed-file.js";
import { migrate } from "../persistence/migrate.js";
import { readCanonicalLog, rebuildProviderPayload, validateCoordinates } from "./canonical-log.js";
import { LibsqlPhaseRecorder, type PhaseEvidenceInput } from "./phase-recorder.js";
import { testAgentSpec } from "../runner/agent-spec.testing.js";

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
    }, () => 100);
    const telemetry: PhaseEvidenceInput = {
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
      spec: await testAgentSpec(),
      result: {
        settled: true,
        failure: null,
        usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 1, costUsd: 0.05 },
        events: [{ type: "agent_settled" }],
      },
    };
    // Two entry points, two rules: the cost row is written on the delivery
    // path, the evidence behind it by the drain loop.
    const cost = await recorder.recordCost(telemetry);
    await recorder.writeEvidence({ ...telemetry, cost: cost.data });

    const canonical = await readCanonicalLog(join(directory, "run-1", "run-events.jsonl"));
    expect(rebuildProviderPayload(canonical)).toEqual(payloads[1]);
    expect(() => validateCoordinates(canonical)).not.toThrow();
    const costs = await client.execute("SELECT provider, model_id, cost_usd FROM cost_entries");
    expect(costs.rows).toMatchObject([{ provider: "mock", model_id: "mock-1", cost_usd: 0.05 }]);
    // The RPC stream belongs to the evidence file; event_log carries what the
    // orchestrator decided, and Epic state is read back out of it.
    expect(canonical.filter((event) => event.type === "rpc/event")).toHaveLength(1);
    const events = await client.execute("SELECT type FROM event_log WHERE run_id = 'run-1'");
    expect(events.rows).toEqual([]);

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

  it("drops the run's capture file once its payloads are in the canonical log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hivemind-phase-capture-"));
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const payloads = [{ model: "mock-1", messages: [{ role: "user", content: "only" }], tools: [] }];
    const recorder = new LibsqlPhaseRecorder(client, { evidenceRoot: directory }, () => 100);
    const capture = join(directory, "run-2", "provider-requests.jsonl");
    await mkdir(join(directory, "run-2"), { recursive: true });
    await writeFile(capture, `${payloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`, "utf8");

    await recorder.writeEvidence({
      runId: "run-2",
      cardId: "card-2",
      phase: "CODE",
      messages: [{ role: "assistant", content: "done", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }],
      providerPayloads: payloads,
      spec: await testAgentSpec(),
      result: { settled: true, failure: null, usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.01 }, events: [] },
    });

    // A provider request carries the whole conversation so far, so keeping the
    // capture beside the log stored every round twice.
    await expect(stat(capture)).rejects.toMatchObject({ code: "ENOENT" });
    const canonical = await readCanonicalLog(join(directory, "run-2", "run-events.jsonl"));
    expect(rebuildProviderPayload(canonical)).toEqual(payloads[0]);
    client.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("packs a capture the canonical log never folded in rather than leaving it flat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hivemind-phase-leftover-"));
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const payloads = [{ model: "mock-1", messages: [{ role: "user", content: "only" }], tools: [] }];
    const recorder = new LibsqlPhaseRecorder(client, { evidenceRoot: directory }, () => 100);
    await mkdir(join(directory, "run-3"), { recursive: true });
    await writeFile(join(directory, "run-3", "provider-requests.jsonl"), `${JSON.stringify(payloads[0])}\n`, "utf8");
    // What the UI review lane leaves: its own pi, its own requests, no log of
    // its own to fold them into.
    const review = join(directory, "run-3", "ui-review-requests.jsonl");
    const written = `${JSON.stringify({ messages: ["y".repeat(2_048)] })}\n`;
    await writeFile(review, written, "utf8");

    await recorder.writeEvidence({
      runId: "run-3",
      cardId: "card-3",
      phase: "VERIFY",
      messages: [{ role: "assistant", content: "done", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }],
      providerPayloads: payloads,
      spec: await testAgentSpec(),
      result: { settled: true, failure: null, usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.01 }, events: [] },
    });

    await expect(stat(review)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readPackedText(review)).toEqual(written);
    client.close();
    await rm(directory, { recursive: true, force: true });
  });
});
