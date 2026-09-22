import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { StoryExecutionStore } from "./story-execution-store.js";
import { decideDispatchFailure, describePhaseExitRefusal, settleDispatchFailure } from "./dispatch-failure.js";
import { renderStopSummary } from "./stop-summary.js";

const CARD = { state: "SHAPE" as const, phaseReentries: 0 };

describe("decideDispatchFailure", () => {
  it("charges nothing for a run this process ended", () => {
    expect(decideDispatchFailure({
      stopping: true, message: "killed", card: CARD, budget: 3,
    })).toEqual({ kind: "cancelled" });
    expect(decideDispatchFailure({
      stopping: false, signal: "SIGTERM", message: "killed", card: CARD, budget: 3,
    })).toEqual({ kind: "cancelled" });
  });

  it("charges nothing for a provider event, whatever the card was doing", () => {
    expect(decideDispatchFailure({
      stopping: false,
      message: "429 You exceeded your current quota",
      card: CARD,
      budget: 3,
    })).toMatchObject({ kind: "provider_fault" });
  });

  it("charges nothing when the host could not run its own command", () => {
    // The host's dependencies were emptied under a running orchestrator and
    // S-R237511TD-02, ninety seconds old, spent all three attempts on this.
    expect(decideDispatchFailure({
      stopping: false,
      message: "Command failed: npm run story:run -- --card-id S-X-01\nsh: tsx: command not found\n",
      card: CARD,
      budget: 3,
    })).toMatchObject({ kind: "host_fault" });
    expect(decideDispatchFailure({
      stopping: false, message: "spawn npm ENOENT", card: CARD, budget: 3,
    })).toMatchObject({ kind: "host_fault" });
    expect(decideDispatchFailure({
      stopping: false, message: "npm ERR! missing script: story:run", card: CARD, budget: 3,
    })).toMatchObject({ kind: "host_fault" });
  });

  it("still charges the card for a failure that is its own to answer for", () => {
    // Deliberately narrow: a missing module or a non-zero exit inside the
    // card's own code says something about the card.
    expect(decideDispatchFailure({
      stopping: false,
      message: "Command failed: npm run story:run\nError: Cannot find module './pages/todo.js'",
      card: CARD,
      budget: 3,
    })).toMatchObject({ kind: "reenter" });
    expect(decideDispatchFailure({
      stopping: false, message: "Command failed with exit code 1", card: CARD, budget: 3,
    })).toMatchObject({ kind: "reenter" });
  });

  it("has nothing to charge when the card is gone or already delivered", () => {
    expect(decideDispatchFailure({ stopping: false, message: "exit 1", budget: 3 }))
      .toEqual({ kind: "ignored" });
    expect(decideDispatchFailure({
      stopping: false, message: "exit 1", card: { state: "DELIVERED", phaseReentries: 0 }, budget: 3,
    })).toEqual({ kind: "ignored" });
  });

  it("re-enters until the budget is gone, then parks", () => {
    expect(decideDispatchFailure({
      stopping: false, message: "exit 1", card: { state: "CODE", phaseReentries: 1 }, budget: 3,
    })).toMatchObject({ kind: "reenter", attempt: 2, budget: 3 });
    expect(decideDispatchFailure({
      stopping: false, message: "exit 1", card: { state: "CODE", phaseReentries: 2 }, budget: 3,
    })).toMatchObject({ kind: "park", attempt: 3 });
  });

  it("parks a phase that is not re-dispatched however much budget is left", () => {
    expect(decideDispatchFailure({
      stopping: false, message: "exit 1", card: { state: "VERIFY", phaseReentries: 0 }, budget: 3,
    })).toMatchObject({ kind: "park", attempt: 1 });
  });
});

const CONFIG = { reload: async () => undefined, get: () => 3 };

async function storeWithCard() {
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const store = new StoryExecutionStore(client, (() => {
    let time = 1_000;
    return () => time++;
  })());
  await store.createStory({
    id: "S-EPIC1-01",
    notionPageId: "page-1",
    title: "Crashed run",
    requirement: "A run that died leaves a record.",
  });
  await store.transition("S-EPIC1-01", "QUEUED", "SHAPE", "system", "run-shape");
  return { client, store };
}

describe("settleDispatchFailure", () => {
  it("records the failure and leaves the card where it was", async () => {
    const { client, store } = await storeWithCard();
    const decision = await settleDispatchFailure({
      store, config: CONFIG, cardId: "S-EPIC1-01", stopping: false, error: new Error("worker exited with code 1"),
    });

    expect(decision).toMatchObject({ kind: "reenter", state: "SHAPE", attempt: 1, budget: 3 });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({ state: "SHAPE", phaseReentries: 1 });
    const events = await client.execute("SELECT type, data FROM event_log WHERE card_id = 'S-EPIC1-01'");
    expect(events.rows.some((row) => row.type === "story.dispatch_failed")).toBe(true);
    client.close();
  });

  it("parks the card with the attempt count and the error class on the stop", async () => {
    const { client, store } = await storeWithCard();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await settleDispatchFailure({
        store, config: CONFIG, cardId: "S-EPIC1-01", stopping: false, error: new Error("worker exited with code 1"),
      });
    }

    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({
      state: "NEEDS_INPUT", stopReason: "retry_limit_exceeded",
    });
    const stopped = JSON.parse(String((await client.execute(
      "SELECT data FROM event_log WHERE type = 'story.stopped' ORDER BY id DESC LIMIT 1",
    )).rows[0]?.data)) as Record<string, unknown>;
    expect(stopped).toMatchObject({
      reason: "retry_limit_exceeded", classification: "reentry", attempt: 3, budget: 3, errorClass: "UNKNOWN",
    });
    client.close();
  });

  it("spends no budget on a shutdown", async () => {
    const { client, store } = await storeWithCard();
    const decision = await settleDispatchFailure({
      store, config: CONFIG, cardId: "S-EPIC1-01", stopping: true, error: new Error("terminated"),
    });

    expect(decision).toEqual({ kind: "cancelled" });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({ state: "SHAPE", phaseReentries: 0 });
    client.close();
  });
});

describe("settleDispatchFailure on a broken host", () => {
  it("writes nothing against the card", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 1_000);
    await store.createStory({
      id: "S-HOST-01", notionPageId: "page", title: "Card", requirement: "r", branch: "story/host-01",
    });

    const decision = await settleDispatchFailure({
      store,
      config: { reload: async () => {}, get: () => 3 },
      cardId: "S-HOST-01",
      error: new Error("Command failed: npm run story:run\nsh: tsx: command not found\n"),
      stopping: false,
    });

    expect(decision).toMatchObject({ kind: "host_fault" });
    const story = (await client.execute("SELECT state, phase_reentries FROM stories WHERE id = 'S-HOST-01'")).rows[0];
    expect(story).toMatchObject({ state: "QUEUED", phase_reentries: 0 });
    expect((await client.execute("SELECT COUNT(*) n FROM event_log WHERE type = 'story.dispatch_failed'")).rows[0]?.n)
      .toBe(0);
    client.close();
  });
});

describe("a run that died of its own phase exit", () => {
  const refused = new Error(`Command failed: npm run story:run -- --card-id S-EXIT-01
judge is answering the questions that declare a deterministic fallback
FAILED: CODE exit checks were not met: No failing-test evidence exists for: S-EXIT-01-a. Each scenario needs a test that failed before the implementation.
`);

  it("is named by the exit that refused it and by what it asked for", () => {
    expect(describePhaseExitRefusal(refused.message)).toMatchObject({
      gate: "CODE",
      detail: expect.stringContaining("No failing-test evidence exists for: S-EXIT-01-a"),
    });
  });

  it("says nothing about a message no exit produced", () => {
    expect(describePhaseExitRefusal("Command failed: git push\n ! [rejected] non-fast-forward\n")).toBeUndefined();
  });

  it("stops the card with the refusal instead of an unplaceable message", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, (() => { let time = 1_000; return () => time++; })());
    await store.createStory({
      id: "S-EXIT-01", notionPageId: "page", title: "Card", requirement: "r", branch: "story/exit-01",
    });
    await store.transition("S-EXIT-01", "QUEUED", "SHAPE", "system", "run-1");
    await client.execute("UPDATE stories SET state = 'CODE', phase = 'CODE', phase_reentries = 2 WHERE id = 'S-EXIT-01'");

    const decision = await settleDispatchFailure({
      store,
      config: { reload: async () => {}, get: () => 3 },
      cardId: "S-EXIT-01",
      error: refused,
      stopping: false,
    });

    expect(decision).toMatchObject({ kind: "park", refusal: { gate: "CODE" } });
    const summary = await store.stopSummary("S-EXIT-01");
    expect(summary?.dispatchFailures[0]?.refusal?.detail).toContain("No failing-test evidence exists");
    expect(summary?.dispatchFailures[0]?.errorClass).toBe("PHASE_EXIT_REFUSED");
    expect(renderStopSummary(summary!)).toContain("CODE refused its own round in CODE");
    client.close();
  });
});
