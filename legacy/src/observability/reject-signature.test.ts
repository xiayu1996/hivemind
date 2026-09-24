import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { loadRejections, rankRejections, rejectionSignature, type RejectionEvent } from "./reject-signature.js";

function rejection(cardId: string, reason: string, at = 1): RejectionEvent {
  return { cardId, phase: "CODE", round: 1, reason, at };
}

describe("rejection signatures", () => {
  it("groups the same problem worded against different files and lines", () => {
    const left = rejectionSignature("src/pipeline/dod.ts:41 uncommitted changes remain in the worktree");
    const right = rejectionSignature("src/notion/blocks.ts:207 uncommitted changes remain in the worktree");
    expect(left.signature).toBe(right.signature);
    expect(left.canonical).toContain("uncommitted changes remain");
  });

  it("keeps two different problems apart", () => {
    expect(rejectionSignature("red proof did not fail at the target symbol").signature)
      .not.toBe(rejectionSignature("uncommitted changes remain in the worktree").signature);
  });

  it("ranks a reason that touched many cards above one that hit a single card often", () => {
    const ranked = rankRejections([
      rejection("S-1", "frozen tests were modified"),
      rejection("S-2", "frozen tests were modified"),
      rejection("S-3", "the delivery report used implementation language"),
      rejection("S-3", "the delivery report used implementation language"),
      rejection("S-3", "the delivery report used implementation language"),
    ]);
    expect(ranked.map((group) => [group.cards.length, group.occurrences]))
      .toEqual([[2, 2], [1, 3]]);
  });
});

describe("loading rejections", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
  });

  it("reads both a phase sent back and the friction a worker recorded", async () => {
    await client.batch([
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES ('run-1', 0, 'S-1', 'CODE', 'phase.invalidated', 10, ?)`,
        args: [JSON.stringify({ round: 2, reason: "frozen tests were modified" })],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES ('run-2', 0, 'S-1', NULL, 'friction.recorded', 11, ?)`,
        args: [JSON.stringify({ kind: "dod_contract_changed", detail: "the DoD was rejected by the contract" })],
      },
      {
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES ('run-3', 0, 'S-1', 'CODE', 'phase.completed', 12, '{}')`,
        args: [],
      },
    ], "write");

    const events = await loadRejections(client);
    expect(events.map((event) => event.reason)).toEqual([
      "frozen tests were modified",
      "dod_contract_changed: the DoD was rejected by the contract",
    ]);
  });
});
