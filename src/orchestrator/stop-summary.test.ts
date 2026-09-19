import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { StoryExecutionStore } from "./story-execution-store.js";
import { renderStopSummary, type StopSummary } from "./stop-summary.js";
import { AlertStopSink, FrictionStopSink, notifyStoryStopped } from "./story-stop-sink.js";
import { AlertRouter, type AlertChannel } from "../alert/index.js";

const SUMMARY: StopSummary = {
  cardId: "S-EPIC1-01",
  reason: "retry_limit_exceeded",
  convergence: "budget_exhausted",
  spent: 3,
  budget: 3,
  rounds: [
    { round: 1, failed: ["S-EPIC1-01-a", "S-EPIC1-01-b"], reasons: [] },
    { round: 2, failed: ["S-EPIC1-01-b"], reasons: [] },
  ],
  mergeBounces: [{ attribution: "story_regression", check: "npm test", failures: ["src/coupon.test.ts > applies the discount"] }],
  baselineFailures: [],
  refusals: [],
  dispatchFailures: [{ state: "SHAPE", errorClass: "UNKNOWN", message: "worker exited with code 1" }],
  costUsd: 6.81,
  diagnosis: {
    curve: [2, 1],
    side: "system",
    reason: "the failing set changed between rounds without settling",
    persistent: [],
    regressed: [],
  },
};

describe("renderStopSummary", () => {
  it("puts everything that happened in one place", () => {
    const rendered = renderStopSummary(SUMMARY);
    expect(rendered).toContain("round 1: 2 failing -> round 2: 1 failing");
    expect(rendered).toContain("Rounds spent: 3 of 3");
    expect(rendered).toContain("src/coupon.test.ts > applies the discount");
    expect(rendered).toContain("A run died in SHAPE");
    expect(rendered).toContain("$6.81");
  });
});

async function stoppedCard(): Promise<{ store: StoryExecutionStore; client: ReturnType<typeof createClient> }> {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const store = new StoryExecutionStore(client, (() => {
    let time = 1_000;
    return () => time++;
  })());
  await store.createStory({
    id: "S-EPIC1-01", notionPageId: "page-1", title: "Story", requirement: "Do the thing.",
  });
  return { store, client };
}

describe("the store's own summary", () => {
  it("collects the rounds, the crashes and the spend at the moment the card stops", async () => {
    const { store, client } = await stoppedCard();
    await client.execute(`INSERT INTO verify_records (card_id, round, code_session_id, verify_session_id, verdict, failed_scenarios, evidence_dir, created_at)
                          VALUES ('S-EPIC1-01', 1, 'c1', 'v1', 'rejected', '["S-EPIC1-01-a"]', '/ev', 100)`);
    await client.execute(`INSERT INTO cost_entries (run_id, card_id, provider, model_id, cost_usd, is_subscription, ts)
                          VALUES ('run-1', 'S-EPIC1-01', 'deepseek', 'deepseek/deepseek-v4', 6.81, 0, 100)`);
    await store.recordDispatchFailure({
      cardId: "S-EPIC1-01", state: "QUEUED", errorClass: "UNKNOWN",
      message: "worker exited with code 1", attempt: 1, budget: 3, runId: "reentry-1",
    });

    await store.stopForInput("S-EPIC1-01", "QUEUED", "retry_limit_exceeded", "run-stop", {
      convergence: "budget_exhausted", spent: 3, budget: 3,
    });

    const summary = await store.stopSummary("S-EPIC1-01");
    expect(summary).toMatchObject({
      reason: "retry_limit_exceeded",
      convergence: "budget_exhausted",
      spent: 3,
      budget: 3,
      costUsd: 6.81,
      dispatchFailures: [{ state: "QUEUED", errorClass: "UNKNOWN" }],
    });
    expect(summary?.rounds).toMatchObject([{ round: 1, failed: ["S-EPIC1-01-a"] }]);
    // The same thing the page and the alert read is on the event too.
    const stopped = JSON.parse(String((await client.execute(
      "SELECT data FROM event_log WHERE type = 'story.stopped' ORDER BY id DESC LIMIT 1",
    )).rows[0]?.data)) as { summary?: StopSummary };
    expect(stopped.summary?.costUsd).toBe(6.81);
    client.close();
  });

  it("stops offering the summary once a person has restarted the card", async () => {
    const { store, client } = await stoppedCard();
    await store.stopForInput("S-EPIC1-01", "QUEUED", "blocking_question", "run-stop");
    expect(await store.stopSummary("S-EPIC1-01")).not.toBeNull();

    await store.transition("S-EPIC1-01", "NEEDS_INPUT", "SHAPE", "human", "human-answer");

    // The rounds it describes are no longer why the card is where it is.
    expect(await store.stopSummary("S-EPIC1-01")).toBeNull();
    client.close();
  });

  it("offers no diagnosis for a card that only ran out of money", async () => {
    const { store, client } = await stoppedCard();
    await store.stopForInput("S-EPIC1-01", "QUEUED", "cost_ceiling_exceeded", "run-stop");

    expect((await store.stopSummary("S-EPIC1-01"))?.diagnosis).toBeUndefined();
    client.close();
  });
});

describe("notifyStoryStopped", () => {
  it("tells every sink even when one refuses", async () => {
    const channel: AlertChannel = { name: "test", send: vi.fn(async () => undefined) };
    const friction = { record: vi.fn(async () => undefined) };
    const broken = { onStoryStopped: vi.fn(async () => { throw new Error("no channel"); }) };

    const result = await notifyStoryStopped(
      [broken, new AlertStopSink(new AlertRouter([channel])), new FrictionStopSink(friction)],
      SUMMARY,
    );

    expect(result.failed).toHaveLength(1);
    expect(channel.send).toHaveBeenCalledOnce();
    expect(friction.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "story_stopped" }));
  });

  it("keeps a spend stop out of the reflection pipeline", async () => {
    const friction = { record: vi.fn(async () => undefined) };

    await notifyStoryStopped([new FrictionStopSink(friction)], { ...SUMMARY, reason: "cost_ceiling_exceeded" });

    // Reaching a money ceiling says nothing about whether the work is doable.
    expect(friction.record).not.toHaveBeenCalled();
  });
});

describe("a card stopped because nothing could be judged", () => {
  it("says the environment never came up, and claims no budget it was not given", () => {
    const rendered = renderStopSummary({
      cardId: "S-EPIC-01",
      reason: "retry_limit_exceeded",
      spent: 2,
      inconclusive: { attempts: 3, scenarios: ["S-EPIC-01-open", "S-EPIC-01-save"] },
      rounds: [],
      mergeBounces: [],
      baselineFailures: [],
      refusals: [],
      dispatchFailures: [],
      costUsd: 0,
    });

    expect(rendered).toContain("The environment would not stand up 3 rounds running");
    expect(rendered).toContain("S-EPIC-01-open, S-EPIC-01-save");
    // "of 0" read as a budget of zero, which the code does not allow to exist.
    expect(rendered).toContain("Rounds spent: 2");
    expect(rendered).not.toContain("of 0");
  });
});
