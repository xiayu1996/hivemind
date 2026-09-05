import { describe, expect, it } from "vitest";
import {
  analyzeCacheTurns,
  diagnosticsFromMessages,
  turnUsageFromMessages,
  type TurnUsage,
} from "./cache-analysis.js";

function turn(index: number, input: number, cacheRead: number, output: number): TurnUsage {
  return { turn: index, input, cacheRead, cacheWrite: 0, output };
}

describe("analyzeCacheTurns", () => {
  it("reports no losses when every turn serves its whole previous context", () => {
    const analysis = analyzeCacheTurns([
      turn(1, 2341, 0, 34),
      turn(2, 1848, 2375, 18),
      turn(3, 1848, 4241, 18),
    ]);
    expect(analysis.losses).toEqual([]);
    expect(analysis.lostTokens).toBe(0);
    expect(analysis.actualHitRate).toBeCloseTo(analysis.idealHitRate, 6);
  });

  it("separates a structural ceiling from a genuine loss", () => {
    // Observed on a real DECOMPOSE session: the third and fifth turns were sent
    // to a cold shard and nothing was served, although the context was there.
    const analysis = analyzeCacheTurns([
      turn(1, 3733, 0, 149),
      turn(2, 3972, 3584, 147),
      turn(3, 18464, 0, 226),
      turn(4, 3764, 18304, 792),
      turn(5, 22882, 0, 2071),
    ]);
    expect(analysis.losses.map((loss) => loss.turn)).toEqual([3, 5]);
    expect(analysis.losses[0]).toMatchObject({ lostTokens: 3972 + 3584 + 147, servedFraction: 0 });
    expect(analysis.actualHitRate).toBeCloseTo(0.29, 2);
    expect(analysis.idealHitRate).toBeCloseTo(0.71, 2);
    expect(analysis.lostTokens).toBe(analysis.losses[0]!.lostTokens + analysis.losses[1]!.lostTokens);
  });

  it("tolerates block rounding but flags a partial loss", () => {
    const rounded = analyzeCacheTurns([turn(1, 1000, 0, 100), turn(2, 300, 1024, 10)]);
    expect(rounded.losses).toEqual([]);

    const partial = analyzeCacheTurns([turn(1, 3000, 0, 100), turn(2, 5000, 2560, 10)]);
    expect(partial.losses).toHaveLength(1);
    expect(partial.losses[0]!.servedFraction).toBeCloseTo(2560 / 3100, 6);
  });

  it("handles an empty or single-turn session without division by zero", () => {
    expect(analyzeCacheTurns([])).toMatchObject({ turns: 0, actualHitRate: 0, idealHitRate: 0, losses: [] });
    expect(analyzeCacheTurns([turn(1, 500, 0, 5)])).toMatchObject({ turns: 1, actualHitRate: 0, idealHitRate: 0 });
  });
});

describe("turnUsageFromMessages", () => {
  it("numbers only assistant messages that carry usage", () => {
    const turns = turnUsageFromMessages([
      { role: "user", content: "go" },
      { role: "assistant", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2 } },
      { role: "toolResult", content: [] },
      { role: "assistant", content: "no usage on this one" },
      { role: "assistant", usage: { input: 3, cacheRead: 12, output: 1 } },
    ]);
    expect(turns).toEqual([
      { turn: 1, input: 10, cacheRead: 0, cacheWrite: 0, output: 2 },
      { turn: 2, input: 3, cacheRead: 12, cacheWrite: 0, output: 1 },
    ]);
  });
});

describe("diagnosticsFromMessages", () => {
  it("attributes diagnostics to the turn they were attached to", () => {
    const found = diagnosticsFromMessages([
      { role: "assistant", usage: { input: 1 } },
      { role: "assistant", usage: { input: 1 }, diagnostics: [{ kind: "provider_transport_failure" }] },
      { role: "assistant", usage: { input: 1 }, diagnostics: [] },
    ]);
    expect(found).toEqual([{ turn: 2, diagnostics: [{ kind: "provider_transport_failure" }] }]);
  });
});
