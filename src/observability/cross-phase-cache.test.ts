import { describe, expect, it } from "vitest";
import { summarizeCrossPhaseCache, type PhaseTurn } from "./cross-phase-cache.js";

function turn(partial: Partial<PhaseTurn> & Pick<PhaseTurn, "runId" | "phase" | "turn" | "startedAt">): PhaseTurn {
  return { input: 0, cacheRead: 0, cacheWrite: 0, ...partial };
}

describe("cross-phase cache", () => {
  it("reads the reuse off the first turn of each later spawn", () => {
    const summary = summarizeCrossPhaseCache("S-E1-01", [
      turn({ runId: "design-1", phase: "DESIGN", turn: 1, startedAt: 1, input: 1000, cacheWrite: 0 }),
      turn({ runId: "design-1", phase: "DESIGN", turn: 2, startedAt: 1, input: 100, cacheRead: 1000 }),
      turn({ runId: "code-1", phase: "CODE", turn: 1, startedAt: 2, input: 200, cacheRead: 800 }),
    ]);
    const build = summary.lanes.find((lane) => lane.lane === "build")!;
    expect(build).toMatchObject({ spawns: 2, reusableSpawns: 1, coldEntries: [] });
    expect(build.entryHitRate).toBeCloseTo(0.8);
  });

  it("does not blame the first spawn of a lane for having nothing to hit", () => {
    const summary = summarizeCrossPhaseCache("S-E1-01", [
      turn({ runId: "design-1", phase: "DESIGN", turn: 1, startedAt: 1, input: 1000 }),
    ]);
    expect(summary.lanes[0]).toMatchObject({ spawns: 1, reusableSpawns: 0, entryHitRate: 0, coldEntries: [] });
  });

  it("names the phases that entered cold", () => {
    const summary = summarizeCrossPhaseCache("S-E1-01", [
      turn({ runId: "design-1", phase: "DESIGN", turn: 1, startedAt: 1, input: 1000 }),
      turn({ runId: "specify-1", phase: "SPECIFY", turn: 1, startedAt: 2, input: 1000 }),
    ]);
    expect(summary.lanes[0]!.coldEntries).toEqual(["SPECIFY"]);
  });

  it("keeps the two lanes apart, because they route on different keys", () => {
    const summary = summarizeCrossPhaseCache("S-E1-01", [
      turn({ runId: "code-1", phase: "CODE", turn: 1, startedAt: 1, input: 1000 }),
      turn({ runId: "verify-1", phase: "VERIFY", turn: 1, startedAt: 2, input: 1000 }),
      turn({ runId: "code-2", phase: "CODE", turn: 1, startedAt: 3, input: 100, cacheRead: 900 }),
      turn({ runId: "verify-2", phase: "VERIFY", turn: 1, startedAt: 4, input: 1000 }),
    ]);
    expect(summary.lanes.map((lane) => [lane.lane, lane.reusableSpawns, Math.round(lane.entryHitRate * 100)]))
      .toEqual([["build", 1, 90], ["verify", 1, 0]]);
  });
});
