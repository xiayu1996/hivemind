import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeduplicatingTelemetryReceiver,
  JsonlTelemetrySpool,
  TelemetryEmitter,
  TelemetryExportWorker,
  type ExportEnvelope,
  type TelemetrySink,
  type TelemetrySpool,
} from "./exporter.js";

function envelope(seq: number): ExportEnvelope {
  return { runId: "run-1", event: { type: "assistant_message", seq, time: seq, data: { text: `message-${seq}` } } };
}

describe("telemetry exporter", () => {
  it("keeps emit synchronous and the agent loop independent of a failed sink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hm-export-"));
    const emitter = new TelemetryEmitter();
    const worker = new TelemetryExportWorker(emitter, new JsonlTelemetrySpool(join(directory, "spool.jsonl")));
    for (let seq = 0; seq < 3; seq++) emitter.emit(envelope(seq));
    expect(emitter.depth).toBe(3);
    await worker.persistCaptured();
    expect(emitter.depth).toBe(0);

    const down: TelemetrySink = { send: async () => { throw new Error("receiver down"); } };
    await expect(worker.deliver("central", down)).rejects.toThrow(/receiver down/);
    const accepted: ExportEnvelope[] = [];
    await expect(worker.deliver("central", { send: async (batch) => { accepted.push(...batch); } })).resolves.toBe(3);
    expect(accepted.map((item) => item.event.seq)).toEqual([0, 1, 2]);
  });

  it("deduplicates a crash-window replay by run and sequence", async () => {
    const rows = [envelope(0), envelope(1)];
    let cursor = -1;
    let failCursor = true;
    const spool: TelemetrySpool = {
      append: async () => undefined,
      readAfter: async (after) => rows.map((item, offset) => ({ envelope: item, offset })).filter((item) => item.offset > after),
      getCursor: async () => cursor,
      setCursor: async (_sink, value) => {
        if (failCursor) { failCursor = false; throw new Error("crash before cursor"); }
        cursor = value;
      },
    };
    const accepted: ExportEnvelope[] = [];
    const receiver = new DeduplicatingTelemetryReceiver(async (item) => { accepted.push(item); });
    const worker = new TelemetryExportWorker(new TelemetryEmitter(), spool);
    await expect(worker.deliver("central", receiver)).rejects.toThrow(/crash/);
    await expect(worker.deliver("central", receiver)).resolves.toBe(2);
    expect(accepted.map((item) => item.event.seq)).toEqual([0, 1]);
  });

  it("redacts secrets in the spool while leaving the emitted canonical record untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hm-export-redact-"));
    const emitter = new TelemetryEmitter();
    const source = envelope(0);
    source.event.data = { authorization: "Bearer top-secret-value" };
    emitter.emit(source);
    const spool = new JsonlTelemetrySpool(join(directory, "spool.jsonl"));
    const worker = new TelemetryExportWorker(emitter, spool);
    await worker.persistCaptured();
    const persisted = (await spool.readAfter(-1, 10))[0]!.envelope;
    expect(JSON.stringify(persisted)).not.toContain("top-secret-value");
    expect(JSON.stringify(source)).toContain("top-secret-value");
  });
});
