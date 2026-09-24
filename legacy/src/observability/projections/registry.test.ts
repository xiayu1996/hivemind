import { describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../canonical-log.js";
import { ProjectionRegistry } from "./registry.js";
import type { ProjectionCacheRecord } from "./types.js";
import { costProjection, statsProjection, tokenUsageProjection, traceProjection } from "./units.js";

const definitions = [tokenUsageProjection, costProjection, statsProjection, traceProjection] as never;

function event(type: string, seq: number, time: number, data: unknown = {}): CanonicalEvent {
  return { type, seq, time, data };
}

const events = [
  event("turn_start", 0, 100, { turn: 1 }),
  event("step_start", 1, 110, { turn: 1, step: 1 }),
  event("assistant/chunk", 2, 130, { turn: 1, step: 1, text: "first" }),
  event("tool_call", 3, 140, { turn: 1, step: 1, callId: "call-1" }),
  event("tool_result", 4, 165, { turn: 1, step: 1, callId: "call-1" }),
  event("assistant_message", 5, 180, { turn: 1, step: 1 }),
  event("usage", 6, 181, { uncachedInput: 10, output: 5, cacheRead: 7, cacheWrite: 2, reasoning: 3 }),
  event("cost.recorded", 7, 182, { costUsd: 0.12 }),
  event("step_end", 8, 185, { turn: 1, step: 1 }),
  event("turn_end", 9, 190, { turn: 1, reason: "completed" }),
];

describe("projection registry", () => {
  it("folds token, cost, stats and trace as pure units", async () => {
    const registry = new ProjectionRegistry("run-1", definitions);
    await registry.rebuild(events);
    expect(registry.view("tokenUsage")).toEqual({ uncachedInput: 10, output: 5, cacheRead: 7, cacheWrite: 2, reasoning: 3 });
    expect(registry.view("cost")).toEqual({ usd: 0.12 });
    expect(registry.view("stats")).toEqual({ turns: 1, steps: 1, llmMs: 70, toolMs: 25, ttftMs: 20, ttftSamples: 1 });
    expect((registry.view<{ nodes: unknown[] }>("trace")).nodes).toHaveLength(7);
  });

  it("re-folds to the same value with no cache", async () => {
    const cacheRows: ProjectionCacheRecord[] = [];
    const cached = new ProjectionRegistry("run-1", definitions, { put: async (row) => { cacheRows.push(row); } });
    await cached.rebuild(events);
    const rebuilt = new ProjectionRegistry("run-1", definitions);
    await rebuilt.rebuild(events);
    expect(rebuilt.view("stats")).toEqual(cached.view("stats"));
    expect(cacheRows.length).toBeGreaterThan(0);
  });

  it("keeps cache failures fail-soft after the log commit boundary", async () => {
    const put = vi.fn(async () => { throw new Error("cache unavailable"); });
    const registry = new ProjectionRegistry("run-1", definitions, { put });
    await expect(registry.applyCommitted(events[0]!)).resolves.toBeUndefined();
    expect(registry.view("stats")).toMatchObject({ turns: 0 });
  });

  it("rejects duplicate or out-of-order committed events", async () => {
    const registry = new ProjectionRegistry("run-1", definitions);
    await registry.applyCommitted(events[0]!);
    await expect(registry.applyCommitted(events[0]!)).rejects.toThrow(/non-monotonic/);
  });
});
