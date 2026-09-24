import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../persistence/migrate.js";
import { foldCard, foldFleet, loadCardSummary, type RunSummary } from "./cascade.js";
import { ProjectionService } from "./service.js";

function run(partial: Partial<RunSummary> & Pick<RunSummary, "runId" | "phase" | "round">): RunSummary {
  return {
    cardId: "S-E1-01",
    status: "completed",
    startedAt: 1,
    endedAt: 2,
    costUsd: 0,
    cacheReadTokens: 0,
    billedInputTokens: 0,
    ...partial,
  };
}

describe("three-scale projection", () => {
  it("folds a card out of its runs", () => {
    const card = foldCard({
      cardId: "S-E1-01",
      state: "CODE",
      phase: "CODE",
      stopReason: null,
      runs: [
        run({ runId: "design-1", phase: "DESIGN", round: 1, costUsd: 0.2, cacheReadTokens: 0, billedInputTokens: 1000 }),
        run({ runId: "code-1", phase: "CODE", round: 2, costUsd: 0.3, cacheReadTokens: 900, billedInputTokens: 1000, status: "failed" }),
      ],
    });
    expect(card).toMatchObject({ runs: 2, failedRuns: 1, rounds: 2, costUsd: 0.5 });
    expect(card.cacheHitRate).toBeCloseTo(0.45);
  });

  it("computes the fleet from card values alone", () => {
    const fleet = foldFleet([
      foldCard({ cardId: "a", state: "CODE", phase: "CODE", stopReason: null, runs: [run({ runId: "r1", phase: "CODE", round: 1, costUsd: 1 })] }),
      foldCard({
        cardId: "b",
        state: "NEEDS_INPUT",
        phase: "VERIFY",
        stopReason: "verify_loop_exceeded",
        runs: [run({ runId: "r2", phase: "VERIFY", round: 3, costUsd: 2, status: "failed" })],
      }),
    ]);
    expect(fleet).toMatchObject({
      cards: 2,
      byState: { CODE: 1, NEEDS_INPUT: 1 },
      costUsd: 3,
      stoppedByReason: { verify_loop_exceeded: 1 },
      worstCards: [{ cardId: "b", failedRuns: 1 }],
    });
  });
});

describe("projection service", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    await client.execute({
      sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, phase, repo, branch, target_branch,
                                 created_at, updated_at)
            VALUES ('S-E1-01', 'page-1', 'Story', 'Requirement', 'CODE', 'CODE', 'owner/name', 'story/s-e1-01', 'main', 1, 1)`,
      args: [],
    });
  });

  it("takes the whole board on the first pass and only what changed after", async () => {
    const service = new ProjectionService(client);
    expect(await service.refresh()).toBe(1);
    expect(service.fleet()).toMatchObject({ cards: 1, byState: { CODE: 1 } });
    // Nothing happened since: a second pass recomputes nothing.
    expect(await service.refresh()).toBe(0);

    await client.execute({
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES ('run-1', 0, 'S-E1-01', 'CODE', 'story.transitioned', 2, '{}')`,
      args: [],
    });
    expect(await service.refresh()).toBe(1);
  });

  it("reads a card straight from the store when asked for one", async () => {
    expect(await loadCardSummary(client, "S-E1-01")).toMatchObject({ cardId: "S-E1-01", state: "CODE", runs: 0 });
    expect(await loadCardSummary(client, "missing")).toBeNull();
  });

  it("refreshes on a nudge instead of waiting out the tick", async () => {
    let ticks = 0;
    const service = new ProjectionService(client, { sleep: async () => { ticks += 1; await new Promise<void>(() => undefined); } });
    service.start();
    await vi.waitFor(() => expect(ticks).toBe(1));

    await client.execute({
      sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
            VALUES ('run-1', 0, 'S-E1-01', 'CODE', 'story.transitioned', 2, '{}')`,
      args: [],
    });
    service.nudge();

    await vi.waitFor(() => expect(ticks).toBe(2));
    await service.stop();
  });

  it("keeps looping after a failed pass: a projection nobody can compute is a reader's problem", async () => {
    const errors: unknown[] = [];
    const service = new ProjectionService(client, {
      intervalMs: 1,
      onError: (error) => errors.push(error),
    });
    const broken = { execute: async () => { throw new Error("database is gone"); } } as unknown as Client;
    Object.assign(service, { client: broken });

    service.start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(1));
    await service.stop();

    expect((errors[0] as Error).message).toBe("database is gone");
  });

  it("stops when told to, so killing ring 2 is a supported move", async () => {
    let passes = 0;
    const service = new ProjectionService(client, { intervalMs: 1, sleep: async (ms) => { passes += 1; await new Promise<void>((resolve) => { setTimeout(resolve, ms); }); } });
    service.start();
    // A second start is the same loop, not a second one racing it.
    service.start();
    await vi.waitFor(() => expect(passes).toBeGreaterThan(0));

    await service.stop();
    const after = passes;

    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    expect(passes).toBe(after);
  });
});
