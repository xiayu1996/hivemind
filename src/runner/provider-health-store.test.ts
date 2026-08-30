import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { LibsqlProviderHealthStore } from "./provider-health-store.js";
import type { BreakerPolicy } from "./circuit-breaker.js";

const policy: BreakerPolicy = {
  failureThreshold: 3,
  transientOpenMs: 60_000,
  rateLimitOpenMs: 30_000,
  deferWithinMinutes: 15,
};

describe("LibsqlProviderHealthStore", () => {
  let client: ReturnType<typeof createClient>;
  let store: LibsqlProviderHealthStore;
  let time: number;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    time = 1_700_000_000_000;
    store = new LibsqlProviderHealthStore(client, () => time);
  });

  afterEach(() => client.close());

  async function events(): Promise<Array<{ type: string; data: string }>> {
    return (await client.execute("SELECT type, data FROM event_log ORDER BY id")).rows
      .map((row) => ({ type: String(row.type), data: String(row.data) }));
  }

  it("carries health across processes, because the account is shared by every host", async () => {
    await store.recordFailure("openai-codex", "You have hit your ChatGPT usage limit (plus plan). Try again in ~47 min.", policy);

    const reread = await new LibsqlProviderHealthStore(client, () => time).snapshot();
    expect(reread.get("openai-codex")).toMatchObject({
      provider: "openai-codex",
      state: "open",
      retryAt: time + 47 * 60_000,
      needsHuman: false,
      lastErrorClass: "QUOTA",
    });
  });

  it("logs the transition once, not once per failure", async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await store.recordFailure("openai-codex", "socket hang up", policy);
      time += 1_000;
    }

    expect((await events()).filter((event) => event.type === "provider.opened")).toHaveLength(1);
    const snapshot = await store.snapshot();
    expect(snapshot.get("openai-codex")).toMatchObject({ state: "open", consecutiveFailures: 4 });
  });

  it("closes on the next success and records the recovery", async () => {
    for (let attempt = 0; attempt < 3; attempt++) await store.recordFailure("openai-codex", "fetch failed", policy);
    time += 120_000;
    await store.recordSuccess("openai-codex");

    expect((await events()).map((event) => event.type)).toEqual(["provider.opened", "provider.closed"]);
    expect((await store.snapshot()).get("openai-codex")).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
      openedAt: null,
      lastError: null,
    });
  });

  it("stays quiet when a success finds the provider already closed", async () => {
    await store.recordSuccess("openai-codex");
    await store.recordSuccess("openai-codex");
    expect(await events()).toEqual([]);
  });

  it("keeps each provider's health separate", async () => {
    await store.recordFailure("openai-codex", "401: unauthorized", policy);
    await store.recordSuccess("zai-coding-cn");

    const snapshot = await store.snapshot();
    expect(snapshot.get("openai-codex")).toMatchObject({ state: "open", needsHuman: true });
    expect(snapshot.get("zai-coding-cn")).toMatchObject({ state: "closed" });
  });

  it("records a probe attempt so an operator can see the breaker is being tried", async () => {
    await store.recordFailure("openai-codex", "401: unauthorized", policy);
    time += 5_000;
    await store.recordProbe("openai-codex", false);
    expect((await store.snapshot()).get("openai-codex")).toMatchObject({ state: "open", lastProbeAt: time });

    time += 5_000;
    await store.recordProbe("openai-codex", true);
    expect((await store.snapshot()).get("openai-codex")).toMatchObject({ state: "closed", lastProbeAt: time });
  });
});
