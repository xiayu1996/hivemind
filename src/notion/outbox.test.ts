import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../persistence/migrate.js";
import {
  NotionOutbox,
  OUTBOX_CLAIM_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_TRANSIENT_WINDOW_MS,
  deadLetters,
  transientBackoffMs,
  type NotionOutboxDelivery,
} from "./outbox.js";

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

  it("sends a payload again once a different one reached the same target", async () => {
    const outbox = new NotionOutbox(client);
    const stopped = await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { stopped: true }, priority: 2 });
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 1 WHERE id = ?", args: [stopped.id] });
    const resumed = await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { stopped: false }, priority: 2 });
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 2 WHERE id = ?", args: [resumed.id] });

    const again = await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { stopped: true }, priority: 2 });
    expect(again).toMatchObject({ id: stopped.id, inserted: true });
    const row = (await client.execute({ sql: "SELECT state FROM notion_outbox WHERE id = ?", args: [stopped.id] })).rows[0];
    expect(row).toMatchObject({ state: "pending" });
  });

  it("collapses a payload that is still the newest thing the target was given", async () => {
    const outbox = new NotionOutbox(client);
    const first = await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { round: 1 }, priority: 2 });
    await client.execute("UPDATE notion_outbox SET state = 'sent', sent_at = 1");
    const again = await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { round: 1 }, priority: 2 });
    expect(again).toMatchObject({ id: first.id, inserted: false });
    const row = (await client.execute("SELECT state FROM notion_outbox")).rows[0];
    expect(row).toMatchObject({ state: "sent" });
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

  it("sends a row once when two replays overlap, because an append cannot be undone", async () => {
    const outbox = new NotionOutbox(client);
    await outbox.enqueue({ target: "story-1", operation: "sync_story_page", payload: { round: 5 }, priority: 3 });
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const sends: number[] = [];
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async (record) => { sends.push(record.id); release(); await new Promise((r) => setTimeout(r, 20)); },
    };

    const first = outbox.replay(delivery);
    await started;
    const second = await outbox.replay(delivery);
    const firstResult = await first;

    expect(sends).toHaveLength(1);
    expect(firstResult.sent).toBe(1);
    expect(second.sent).toBe(0);
  });

  it("hands a row abandoned mid-send to the next replay once its claim runs out", async () => {
    let now = 1_000;
    const outbox = new NotionOutbox(client, () => now);
    await outbox.enqueue({ target: "story-1", operation: "sync_story_page", payload: { round: 5 }, priority: 3 });
    await client.execute({
      sql: "UPDATE notion_outbox SET claimed_until = ?",
      args: [now + OUTBOX_CLAIM_MS],
    });
    const delivery: NotionOutboxDelivery = { isApplied: async () => false, send: async () => {} };

    expect((await outbox.replay(delivery)).sent).toBe(0);
    now += OUTBOX_CLAIM_MS + 1;
    expect((await outbox.replay(delivery)).sent).toBe(1);
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

    expect(await outbox.replay(delivery, { operations: ["sync_requirement_page"] })).toEqual({ sent: 1, failed: 0, failures: [], dead: [], superseded: [] });
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
    expect(await outbox.replay(delivery)).toEqual({ sent: 1, failed: 0, failures: [], dead: [], superseded: [] });
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
    expect(await outbox.replay(delivery)).toEqual({ sent: 3, failed: 0, failures: [], dead: [], superseded: [] });
    expect(order).toEqual(["high-1", "high-2", "low"]);
  });

  it("sends a revived payload after whatever reached its target in between", async () => {
    let clock = 10;
    const outbox = new NotionOutbox(client, () => (clock += 1));
    const stopped = await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { stopped: true }, priority: 2 });
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 1 WHERE id = ?", args: [stopped.id] });
    await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { stopped: false }, priority: 2 });
    await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { stopped: true }, priority: 2 });

    const order: unknown[] = [];
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async (record) => { order.push(record.payload); },
    };
    expect(await outbox.replay(delivery)).toMatchObject({ sent: 2, failed: 0 });
    expect(order).toEqual([{ stopped: false }, { stopped: true }]);
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
      superseded: [],
    });
    // The healthy row went out on the first pass; the dead one is no longer offered.
    expect(sends).toBe(OUTBOX_MAX_ATTEMPTS + 1);
    expect(await outbox.replay(delivery)).toEqual({ sent: 0, failed: 0, failures: [], dead: [], superseded: [] });
    expect(sends).toBe(OUTBOX_MAX_ATTEMPTS + 1);

    const row = (await client.execute("SELECT state, attempts, last_error FROM notion_outbox WHERE target = 'page-1'")).rows[0];
    expect(row).toMatchObject({ state: "dead", attempts: OUTBOX_MAX_ATTEMPTS, last_error: "validation_error on page-1" });
    expect(await deadLetters(client)).toEqual([expect.objectContaining({ target: "page-1", attempts: OUTBOX_MAX_ATTEMPTS })]);
  });
});

const timeout = (): never => {
  throw new Error("The operation was aborted due to timeout");
};

describe("a send that fails on something other than its payload", () => {
  it("waits before trying again rather than spending the pass it was offered", async () => {
    let clock = 1_000;
    const outbox = new NotionOutbox(client, () => clock);
    await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { n: 1 }, priority: 2 });
    let sends = 0;
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async () => { sends++; timeout(); },
    };

    expect(await outbox.replay(delivery)).toMatchObject({ failed: 1, dead: [] });
    expect(sends).toBe(1);

    // The cycle comes round again straight away; the row is not offered yet.
    clock += 1_000;
    expect(await outbox.replay(delivery)).toEqual({ sent: 0, failed: 0, failures: [], dead: [], superseded: [] });
    expect(sends).toBe(1);

    clock += transientBackoffMs(1);
    expect(await outbox.replay(delivery)).toMatchObject({ failed: 1, dead: [] });
    expect(sends).toBe(2);
  });

  it("keeps the row alive past the budget a refused payload gets", async () => {
    let clock = 1_000;
    const outbox = new NotionOutbox(client, () => clock);
    await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { n: 1 }, priority: 2 });
    let fail = true;
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async () => { if (fail) timeout(); },
    };

    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS + 2; attempt++) {
      expect(await outbox.replay(delivery)).toMatchObject({ failed: 1, dead: [] });
      clock += transientBackoffMs(attempt);
    }
    fail = false;
    expect(await outbox.replay(delivery)).toMatchObject({ sent: 1, dead: [] });
    const row = (await client.execute("SELECT state, next_attempt_at FROM notion_outbox WHERE target = 'page-1'")).rows[0];
    expect(row).toMatchObject({ state: "sent", next_attempt_at: null });
  });

  it("declares the row dead once it has been failing this way for longer than an outage", async () => {
    let clock = 1_000;
    const outbox = new NotionOutbox(client, () => clock);
    await outbox.enqueue({ target: "page-1", operation: "sync_story_page", payload: { n: 1 }, priority: 2 });
    const delivery: NotionOutboxDelivery = {
      isApplied: async () => false,
      send: async () => timeout(),
    };

    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      expect(await outbox.replay(delivery)).toMatchObject({ failed: 1, dead: [] });
      clock += transientBackoffMs(attempt);
    }
    clock += OUTBOX_TRANSIENT_WINDOW_MS;
    expect(await outbox.replay(delivery)).toMatchObject({
      dead: [expect.objectContaining({ target: "page-1" })],
    });
  });
});

const sendsOf = (seen: number[]): NotionOutboxDelivery => ({
  isApplied: async () => false,
  send: async (record) => { seen.push(record.id); },
});

describe("a row the target moved past while it was failing", () => {
  it("is dropped rather than put back on a page that has since moved on", async () => {
    let now = 10;
    const outbox = new NotionOutbox(client, () => now);
    const stale = await outbox.enqueue({ target: "story-1", operation: "sync_story_page", payload: { round: 1 }, priority: 2 });
    now = 20;
    const fresh = await outbox.enqueue({ target: "story-1", operation: "sync_story_page", payload: { round: 2 }, priority: 2 });
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 21 WHERE id = ?", args: [fresh.id] });

    const sent: number[] = [];
    const result = await outbox.replay(sendsOf(sent), { wholeStateOperations: ["sync_story_page"] });

    expect(sent).toEqual([]);
    expect(result.superseded).toEqual([
      { id: stale.id, cardId: null, operation: "sync_story_page", target: "story-1", attempts: 0 },
    ]);
    const row = (await client.execute({ sql: "SELECT state, attempts FROM notion_outbox WHERE id = ?", args: [stale.id] })).rows[0];
    expect(row).toMatchObject({ state: "sent", attempts: 0 });
  });

  it("is still sent when it adds something of its own, because two comments mean two comments", async () => {
    let now = 10;
    const outbox = new NotionOutbox(client, () => now);
    const first = await outbox.enqueue({ target: "epic-1", operation: "comment_epic_page", payload: { body: "one" }, priority: 2 });
    now = 20;
    const second = await outbox.enqueue({ target: "epic-1", operation: "comment_epic_page", payload: { body: "two" }, priority: 2 });
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 21 WHERE id = ?", args: [second.id] });

    const sent: number[] = [];
    const result = await outbox.replay(sendsOf(sent), { wholeStateOperations: ["sync_story_page"] });

    expect(sent).toEqual([first.id]);
    expect(result.superseded).toEqual([]);
  });

  it("is sent when the older payload is what the target is wanted to hold again", async () => {
    let now = 10;
    const outbox = new NotionOutbox(client, () => now);
    const stopped = await outbox.enqueue({ target: "story-1", operation: "sync_story_page", payload: { stopped: true }, priority: 2 });
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 11 WHERE id = ?", args: [stopped.id] });
    now = 20;
    const resumed = await outbox.enqueue({ target: "story-1", operation: "sync_story_page", payload: { stopped: false }, priority: 2 });
    await client.execute({ sql: "UPDATE notion_outbox SET state = 'sent', sent_at = 21 WHERE id = ?", args: [resumed.id] });
    now = 30;
    await outbox.enqueue({ target: "story-1", operation: "sync_story_page", payload: { stopped: true }, priority: 2 });

    const sent: number[] = [];
    const result = await outbox.replay(sendsOf(sent), { wholeStateOperations: ["sync_story_page"] });

    expect(sent).toEqual([stopped.id]);
    expect(result.superseded).toEqual([]);
  });
});
