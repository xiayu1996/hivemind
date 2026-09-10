import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { NotionOutbox, OUTBOX_MAX_ATTEMPTS, deadLetters, type NotionOutboxDelivery } from "./outbox.js";

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
  it("revives a sent row when the same payload is wanted again after the remote moved on", async () => {
    const db = createClient({ url: ":memory:" });
    await migrate(db);
    const outbox = new NotionOutbox(db, () => 10);
    const first = await outbox.enqueue({ priority: 1, operation: "sync", target: "t", payload: { a: 1 } });
    await db.execute("UPDATE notion_outbox SET state = 'sent', sent_at = 11");
    const replay = await outbox.enqueue({ priority: 1, operation: "sync", target: "t", payload: { a: 1 } });
    expect(replay).toMatchObject({ id: first.id, inserted: false });
    const again = await outbox.enqueue({ priority: 1, operation: "sync", target: "t", payload: { a: 1 }, resend: true });
    expect(again).toMatchObject({ id: first.id, inserted: true });
    const row = (await db.execute("SELECT state, attempts, sent_at FROM notion_outbox")).rows[0];
    expect(row).toMatchObject({ state: "pending", attempts: 0, sent_at: null });
    db.close();
  });

  it("leaves rows for other deliveries alone when told which operations it owns", async () => {
    const outbox = new NotionOutbox(client);
    await outbox.enqueue({ target: "epic-1", operation: "present_epic_plan", payload: { n: 1 }, priority: 1 });
    await outbox.enqueue({ target: "req-1", operation: "sync_requirement_page", payload: { n: 2 }, priority: 1 });
    const seen: string[] = [];
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async (record) => { seen.push(record.operation); },
    };

    expect(await outbox.replay(delivery, { operations: ["sync_requirement_page"] })).toEqual({ sent: 1, failed: 0, failures: [], dead: [] });
    expect(seen).toEqual(["sync_requirement_page"]);
    const untouched = (await client.execute(
      "SELECT state, attempts FROM notion_outbox WHERE operation = 'present_epic_plan'",
    )).rows[0];
    expect(untouched).toMatchObject({ state: "pending", attempts: 0 });
    await expect(outbox.replay(delivery, { operations: [] })).rejects.toThrow(/at least one operation/);
  });

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

    expect(await outbox.replay(delivery)).toMatchObject({
      sent: 0,
      failed: 1,
      failures: [expect.objectContaining({ id: 1, attempts: 1, error: "process died after remote apply" })],
      dead: [],
    });
    expect(await outbox.replay(delivery)).toEqual({ sent: 1, failed: 0, failures: [], dead: [] });
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
    expect(await outbox.replay(delivery)).toEqual({ sent: 3, failed: 0, failures: [], dead: [] });
    expect(order).toEqual(["high-1", "high-2", "low"]);
  });

  it("declares a row dead after its last allowed attempt and stops retrying it", async () => {
    const outbox = new NotionOutbox(client);
    await outbox.enqueue({ target: "page-1", operation: "append_blocks", payload: { n: 1 }, priority: 2 });
    await outbox.enqueue({ target: "page-2", operation: "append_blocks", payload: { n: 2 }, priority: 2 });
    let sends = 0;
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async (record) => {
        sends++;
        if (record.target === "page-1") throw new Error(`validation_error on ${record.target}`);
      },
    };

    for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt++) {
      const result = await outbox.replay(delivery);
      expect(result).toMatchObject({ failed: 1, dead: [] });
      expect(result.failures).toHaveLength(1);
    }
    const last = await outbox.replay(delivery);
    expect(last).toEqual({
      sent: 0,
      failed: 1,
      failures: [expect.objectContaining({ id: 1, attempts: OUTBOX_MAX_ATTEMPTS })],
      dead: [expect.objectContaining({
        cardId: null,
        operation: "append_blocks",
        target: "page-1",
        attempts: OUTBOX_MAX_ATTEMPTS,
        lastError: "validation_error on page-1",
      })],
    });
    // The healthy row went out on the first pass; the dead one is no longer offered.
    expect(sends).toBe(OUTBOX_MAX_ATTEMPTS + 1);
    expect(await outbox.replay(delivery)).toEqual({ sent: 0, failed: 0, failures: [], dead: [] });
    expect(sends).toBe(OUTBOX_MAX_ATTEMPTS + 1);

    const row = (await client.execute("SELECT state, attempts, last_error FROM notion_outbox WHERE target = 'page-1'")).rows[0];
    expect(row).toMatchObject({ state: "dead", attempts: OUTBOX_MAX_ATTEMPTS, last_error: "validation_error on page-1" });
    expect(await deadLetters(client)).toEqual([expect.objectContaining({ target: "page-1", attempts: OUTBOX_MAX_ATTEMPTS })]);
  });
});
