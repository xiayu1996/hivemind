import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { NotionOutbox, type NotionOutboxDelivery } from "./outbox.js";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await migrate(client);
});

afterEach(() => client.close());

describe("enqueue", () => {
  it("stores before delivery and canonicalises payload keys for deduplication", async () => {
    const outbox = new NotionOutbox(client);
    const first = await outbox.enqueue({
      target: "page-1", operation: "append_blocks", payload: { b: 2, a: 1 }, priority: 2,
    });
    const replay = await outbox.enqueue({
      target: "page-1", operation: "append_blocks", payload: { a: 1, b: 2 }, priority: 2,
    });
    expect(replay).toEqual({ id: first.id, inserted: false, payloadHash: first.payloadHash });
    const row = (await client.execute("SELECT state, attempts FROM notion_outbox")).rows[0];
    expect(row).toMatchObject({ state: "pending", attempts: 0 });
  });
});

describe("replay", () => {
  it("does not duplicate a remote effect when the sender crashes before marking sent", async () => {
    const outbox = new NotionOutbox(client);
    await outbox.enqueue({
      target: "page-1", operation: "append_blocks", payload: { children: [{ text: "once" }] }, priority: 2,
    });
    const applied = new Set<string>();
    let sends = 0;
    let crashOnce = true;
    const delivery: NotionOutboxDelivery = {
      isApplied: async (record) => applied.has(`${record.target}:${record.payloadHash}`),
      send: async (record) => {
        sends++;
        applied.add(`${record.target}:${record.payloadHash}`);
        if (crashOnce) {
          crashOnce = false;
          throw new Error("process died after remote apply");
        }
      },
    };

    expect(await outbox.replay(delivery)).toEqual({ sent: 0, failed: 1 });
    expect(await outbox.replay(delivery)).toEqual({ sent: 1, failed: 0 });
    expect(sends).toBe(1);
    const row = (await client.execute("SELECT state, attempts, sent_at FROM notion_outbox")).rows[0];
    expect(row?.state).toBe("sent");
    expect(row?.attempts).toBe(2);
    expect(Number(row?.sent_at)).toBeGreaterThan(0);
  });

  it("replays priority first and FIFO within a priority", async () => {
    const outbox = new NotionOutbox(client);
    await outbox.enqueue({ target: "low", operation: "projection", payload: { n: 1 }, priority: 3 });
    await outbox.enqueue({ target: "high-1", operation: "interaction", payload: { n: 2 }, priority: 0 });
    await outbox.enqueue({ target: "high-2", operation: "interaction", payload: { n: 3 }, priority: 0 });
    const order: string[] = [];
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async (record) => { order.push(record.target); },
    };
    expect(await outbox.replay(delivery)).toEqual({ sent: 3, failed: 0 });
    expect(order).toEqual(["high-1", "high-2", "low"]);
  });
});
