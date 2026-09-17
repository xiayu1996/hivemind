import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { StoryExecutionStore } from "./story-execution-store.js";
import { decideDispatchFailure, settleDispatchFailure } from "./dispatch-failure.js";

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

describe("settleDispatchFailure", () => {
  const config = { reload: async () => undefined, get: () => 3 };

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

  it("records the failure and leaves the card where it was", async () => {
    const { client, store } = await storeWithCard();
    const decision = await settleDispatchFailure({
      store, config, cardId: "S-EPIC1-01", stopping: false, error: new Error("worker exited with code 1"),
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
        store, config, cardId: "S-EPIC1-01", stopping: false, error: new Error("worker exited with code 1"),
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
      store, config, cardId: "S-EPIC1-01", stopping: true, error: new Error("terminated"),
    });

    expect(decision).toEqual({ kind: "cancelled" });
    await expect(store.getStory("S-EPIC1-01")).resolves.toMatchObject({ state: "SHAPE", phaseReentries: 0 });
    client.close();
  });
});
