import { describe, expect, it, vi } from "vitest";
import { EventBuffer, type EventEnvelope } from "./event-buffer.js";
import { DrainLoop, type EventSink } from "./drain.js";

function collector(name: string, events: EventEnvelope[]): EventSink {
  return { name, deliver: async (batch) => { events.push(...batch); } };
}

describe("DrainLoop", () => {
  it("delivers what the buffer holds", async () => {
    const buffer = new EventBuffer();
    const seen: EventEnvelope[] = [];
    const loop = new DrainLoop(buffer, [collector("test", seen)]);
    buffer.emit("phase.started", { phase: "CODE" });
    expect(await loop.tick()).toBe(1);
    expect(seen.map((event) => event.type)).toEqual(["phase.started"]);
  });

  it("keeps going when a sink throws, and counts it", async () => {
    const buffer = new EventBuffer();
    const seen: EventEnvelope[] = [];
    const broken: EventSink = { name: "broken", deliver: async () => { throw new Error("disk full"); } };
    const onSinkFailure = vi.fn();
    const loop = new DrainLoop(buffer, [broken, collector("good", seen)], { onSinkFailure });
    buffer.emit("usage", { input: 1 });
    await loop.tick();
    expect(loop.failures).toBe(1);
    expect(onSinkFailure).toHaveBeenCalledWith("broken", expect.any(Error));
    // The healthy sink still got the batch: one broken writer must not take
    // the others down with it.
    expect(seen).toHaveLength(1);
  });

  it("makes a last pass on stop so a shutdown does not eat the tail", async () => {
    const buffer = new EventBuffer();
    const seen: EventEnvelope[] = [];
    const loop = new DrainLoop(buffer, [collector("test", seen)], { intervalMs: 1 });
    loop.start();
    buffer.emit("turn_end", { turn: 1 });
    await loop.stop();
    expect(seen.map((event) => event.type)).toEqual(["turn_end"]);
  });
});
