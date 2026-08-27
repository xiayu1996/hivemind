import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractFailure, sumUsage } from "./failure.js";
import type { RpcEvent } from "./types.js";

const FIXTURES = join(process.cwd(), "fixtures/rpc-errors");

// Captured from real pi runs against the mock provider (docs/poc/poc-5-error-catalog.md).
const captured = (name: string): RpcEvent[] =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")).events;

describe("extractFailure against captured pi output", () => {
  const cases: Array<[string, RegExp]> = [
    ["auth", /401/],
    ["rate_limit", /429/],
    ["quota", /quota/i],
    ["server", /500/],
    ["invalid_request", /400/],
    ["transport", /connection error/i],
    ["mid_stream_drop", /connection error/i],
  ];

  for (const [name, pattern] of cases) {
    it(`surfaces the ${name} failure`, () => {
      const failure = extractFailure(captured(name));
      expect(failure).not.toBeNull();
      expect(failure!.errorMessage).toMatch(pattern);
    });
  }

  it("covers every captured fixture, so a new sample cannot be silently missed", () => {
    const names = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    expect(names.toSorted()).toEqual(cases.map(([n]) => n).toSorted());
  });

  it("reports pi's own retry intent", () => {
    expect(extractFailure(captured("server"))!.willRetry).toBe(false);
  });

  it("returns null for a clean run", () => {
    const events: RpcEvent[] = [
      { type: "message_end", message: { stopReason: "stop", usage: {} } },
      { type: "agent_end", willRetry: false, messages: [{ stopReason: "stop" }] },
    ];
    expect(extractFailure(events)).toBeNull();
  });

  it("keeps the first error when a run reports several", () => {
    const events: RpcEvent[] = [
      { type: "message_end", message: { stopReason: "error", errorMessage: "first" } },
      { type: "message_end", message: { stopReason: "error", errorMessage: "second" } },
    ];
    expect(extractFailure(events)!.errorMessage).toBe("first");
  });
});

describe("sumUsage", () => {
  it("keeps the four buckets separate and does not add reasoning to output", () => {
    const events: RpcEvent[] = [{
      type: "message_end",
      message: {
        stopReason: "stop",
        usage: { input: 474, output: 46, cacheRead: 10, cacheWrite: 5, reasoning: 25, cost: { total: 0.00056 } },
      },
    }];
    const usage = sumUsage(events);
    expect(usage).toMatchObject({ input: 474, output: 46, cacheRead: 10, cacheWrite: 5, reasoning: 25 });
    expect(usage.output).toBe(46);
    expect(usage.costUsd).toBeCloseTo(0.00056);
  });

  it("accumulates across messages", () => {
    const one = { type: "message_end", message: { usage: { input: 10, output: 2, cost: { total: 1 } } } };
    expect(sumUsage([one, one] as RpcEvent[])).toMatchObject({ input: 20, output: 4, costUsd: 2 });
  });

  it("ignores events without usage", () => {
    expect(sumUsage([{ type: "turn_start" }] as RpcEvent[])).toMatchObject({ input: 0, costUsd: 0 });
  });
});
