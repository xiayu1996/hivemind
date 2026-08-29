import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CanonicalLogWriter,
  parseCanonicalLog,
  rebuildModelRequest,
  recoverInterruptedTurns,
  validateCoordinates,
} from "./canonical-log.js";

describe("canonical log", () => {
  it("serialises concurrent append calls with monotonic sequence numbers", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "hm-log-")), "run-events.jsonl");
    const writer = new CanonicalLogWriter(path, 0, () => 10);
    await Promise.all([
      writer.append("turn_start", { turn: 1 }),
      writer.append("step_start", { turn: 1, step: 1 }),
      writer.append("step_end", { turn: 1, step: 1 }),
      writer.append("turn_end", { turn: 1, reason: "completed" }),
    ]);
    const events = parseCanonicalLog(await readFile(path, "utf8"));
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    expect(() => validateCoordinates(events)).not.toThrow();
  });

  it("rejects an unknown required event but permits an explicitly ignorable one", () => {
    expect(() => parseCanonicalLog('{"type":"future","seq":0,"time":1,"data":{}}\n')).toThrow(/unknown required/);
    expect(parseCanonicalLog('{"type":"future","seq":0,"time":1,"data":{},"ignorable":true}\n')).toHaveLength(1);
  });

  it("rebuilds every model-visible request field", () => {
    const events = parseCanonicalLog([
      JSON.stringify({ type: "request/header", seq: 0, time: 1, data: { systemPrompt: "system", tools: [{ name: "read" }] } }),
      JSON.stringify({ type: "request/context", seq: 1, time: 1, data: { provider: "mock", model: "test", contextWindow: 4096 } }),
      JSON.stringify({ type: "request/messages", seq: 2, time: 1, data: { messages: [{ role: "user", content: "hello" }] } }),
    ].join("\n"));
    expect(rebuildModelRequest(events)).toEqual({
      header: { systemPrompt: "system", tools: [{ name: "read" }] },
      context: { provider: "mock", model: "test", contextWindow: 4096 },
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("lets recovery append interrupted and rejects unpaired normal logs", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "hm-recovery-")), "run-events.jsonl");
    const writer = new CanonicalLogWriter(path, 1, () => 20);
    const original = parseCanonicalLog('{"type":"turn_start","seq":0,"time":1,"data":{"turn":1}}\n');
    expect(() => validateCoordinates(original)).toThrow(/unclosed turns/);
    await expect(recoverInterruptedTurns(writer, original)).resolves.toBe(1);
    const recovered = parseCanonicalLog(`${JSON.stringify(original[0])}\n${await readFile(path, "utf8")}`);
    expect(recovered.at(-1)?.data).toEqual({ turn: 1, reason: "interrupted", synthetic: true });
    expect(() => validateCoordinates(recovered)).not.toThrow();
  });
});
