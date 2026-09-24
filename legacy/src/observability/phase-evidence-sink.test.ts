import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { readCanonicalLog } from "./canonical-log.js";
import { testAgentSpec } from "../runner/agent-spec.testing.js";
import { DrainLoop } from "./drain.js";
import { EventBuffer } from "./event-buffer.js";
import { LibsqlPhaseRecorder, type PhaseEvidenceInput } from "./phase-recorder.js";
import { phaseEvidenceSink } from "./phase-evidence-sink.js";

async function telemetry(runId: string): Promise<PhaseEvidenceInput> {
  return {
    runId,
    cardId: "card-1",
    phase: "CODE",
    messages: [{ role: "assistant", content: "done", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }],
    providerPayloads: [{ model: "mock-1", messages: [] }],
    spec: await testAgentSpec(),
    result: {
      settled: true,
      failure: null,
      usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 0, costUsd: 0.01 },
      events: [{ type: "agent_settled" }],
    },
  };
}

describe("phase evidence sink", () => {
  it("writes a phase's evidence from the drain loop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hivemind-evidence-sink-"));
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const buffer = new EventBuffer();
    const loop = new DrainLoop(buffer, [phaseEvidenceSink(new LibsqlPhaseRecorder(client, { evidenceRoot: directory }))]);

    buffer.emit("phase.telemetry", await telemetry("run-1"));
    await loop.tick();

    const log = await readCanonicalLog(join(directory, "run-1", "run-events.jsonl"));
    expect(log.map((event) => event.type)).toContain("request/provider-payload");
    const turns = await client.execute("SELECT run_id FROM turn_usage");
    expect(turns.rows).toMatchObject([{ run_id: "run-1" }]);
    client.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("counts an envelope it is too old to read instead of refusing the batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hivemind-evidence-sink-"));
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const sink = phaseEvidenceSink(new LibsqlPhaseRecorder(client, { evidenceRoot: directory }));
    const buffer = new EventBuffer();
    buffer.emit("phase.telemetry", await telemetry("run-2"), 99);
    await new DrainLoop(buffer, [sink]).tick();

    expect(sink.ignored).toBe(1);
    const turns = await client.execute("SELECT run_id FROM turn_usage");
    expect(turns.rows).toEqual([]);
    client.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps a card's phase from being blocked by evidence that cannot be written", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const buffer = new EventBuffer();
    // A payload that was never captured is a defect of the observation path;
    // the drain counts it and the pipeline never hears about it.
    const broken = { ...(await telemetry("run-3")), providerPayloads: [] };
    const loop = new DrainLoop(buffer, [phaseEvidenceSink(new LibsqlPhaseRecorder(client, { evidenceRoot: tmpdir() }))]);
    buffer.emit("phase.telemetry", broken);
    await expect(loop.tick()).resolves.toBe(1);
    expect(loop.failures).toBe(1);
    client.close();
  });
});
