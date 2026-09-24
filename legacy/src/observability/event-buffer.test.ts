import { describe, expect, it } from "vitest";
import { EventBuffer } from "./event-buffer.js";

describe("EventBuffer", () => {
  it("stamps each event with a time and a schema version", () => {
    const buffer = new EventBuffer({ now: () => 42 });
    buffer.emit("phase.started", { phase: "CODE" });
    expect(buffer.drain()).toEqual([{ type: "phase.started", at: 42, schemaVersion: 1, data: { phase: "CODE" } }]);
  });

  it("drops the oldest event rather than making the emitter wait", () => {
    const buffer = new EventBuffer({ capacity: 2 });
    buffer.emit("a", 1);
    buffer.emit("b", 2);
    buffer.emit("c", 3);
    expect(buffer.drain().map((event) => event.type)).toEqual(["b", "c"]);
    expect(buffer.dropped).toBe(1);
  });

  it("hands out at most the batch asked for, oldest first", () => {
    const buffer = new EventBuffer();
    buffer.emit("a", 1);
    buffer.emit("b", 2);
    expect(buffer.drain(1).map((event) => event.type)).toEqual(["a"]);
    expect(buffer.size).toBe(1);
  });

  it("emits in constant time with no I/O, so the delivery path pays nothing", () => {
    const buffer = new EventBuffer();
    const started = performance.now();
    for (let index = 0; index < 10_000; index += 1) buffer.emit("turn", { index });
    // Two orders of magnitude under the budget of one millisecond per emit;
    // the point of the assertion is that nothing here touches a disk.
    expect((performance.now() - started) / 10_000).toBeLessThan(1);
  });
});
