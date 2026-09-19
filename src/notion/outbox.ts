import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { isTransientNotionFailure } from "./gateway.js";

export interface EnqueueNotionOperation {
  cardId?: string;
  priority: number;
  operation: string;
  target: string;
  payload: unknown;
  /**
   * The remote moved without us -- a person edited it -- so the payload it
   * last received is no longer what it holds, and it must receive it again
   * even though nothing else was sent to the target since. A payload that
   * recurs after a different one is resent without this flag.
   */
  resend?: boolean;
}

export interface EnqueueResult {
  id: number;
  inserted: boolean;
  payloadHash: string;
}

export interface NotionOutboxRecord {
  id: number;
  cardId: string | null;
  priority: number;
  operation: string;
  target: string;
  payload: unknown;
  payloadHash: string;
  attempts: number;
}

export interface NotionOutboxDelivery {
  /** Checks the target for the operation's durable payload marker/hash. */
  isApplied(record: NotionOutboxRecord): Promise<boolean>;
  send(record: NotionOutboxRecord): Promise<void>;
}

/**
 * How many delivery attempts a row gets before it is declared dead. This
 * budget answers a payload the API refuses, which it refuses identically every
 * time; retrying such a row forever only hides the failure while it holds its
 * place in the queue.
 */
export const OUTBOX_MAX_ATTEMPTS = 8;

/**
 * How long a row whose faults are all transient keeps being retried. A timeout
 * says nothing about the payload, so spending the payload budget on one costs
 * a page write that would have gone through minutes later: at a ten-second
 * cycle the eight attempts above are eighty seconds, which is shorter than a
 * single Notion wobble. After this long a person should look instead.
 */
export const OUTBOX_TRANSIENT_WINDOW_MS = 60 * 60 * 1_000;

/** Longest pause between two attempts at a row that keeps hitting transient
 * faults. Short enough that the board catches up promptly once Notion answers
 * again. */
export const OUTBOX_MAX_BACKOFF_MS = 10 * 60 * 1_000;

/** Doubles from one cycle up to the cap, so an outage is not hammered and a
 * blip costs the board seconds rather than an hour. */
export function transientBackoffMs(attempts: number): number {
  const doubled = 10_000 * 2 ** Math.max(0, attempts - 1);
  return Math.min(doubled, OUTBOX_MAX_BACKOFF_MS);
}

/**
 * How long a replay holds a row it is sending. Long enough to cover a send
 * queued behind the gateway's rate limit, short enough that a replay killed
 * mid-send does not strand the row for the rest of the day.
 */
export const OUTBOX_CLAIM_MS = 2 * 60 * 1_000;

export interface DeadLetter {
  id: number;
  cardId: string | null;
  operation: string;
  target: string;
  attempts: number;
  lastError: string | null;
}

export interface OutboxFailure {
  id: number;
  cardId: string | null;
  operation: string;
  attempts: number;
  error: string;
}

export interface ReplayResult {
  sent: number;
  /** Rows that failed this pass and remain pending, including those just declared dead. */
  failed: number;
  /** Why each row failed this pass. The row's own last_error is cleared on the
   * next attempt, so a transient failure is only ever visible here. */
  failures: OutboxFailure[];
  /** Rows that crossed OUTBOX_MAX_ATTEMPTS during this pass. */
  dead: DeadLetter[];
}

export interface ReplayOptions {
  limit?: number;
  /**
   * The operations this delivery understands. Several processes share one
   * outbox; without the filter each would take the others' rows, fail them,
   * and could hold the head of the queue so its own rows never came up.
   */
  operations?: readonly string[];
}

function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("outbox payload contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`outbox payload contains unsupported ${typeof value}`);
  if (seen.has(value)) throw new TypeError("outbox payload contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("outbox payload must contain only plain JSON objects");
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).toSorted()) result[key] = canonicalValue(source[key], seen);
    return result;
  } finally {
    seen.delete(value);
  }
}

export function canonicalPayload(payload: unknown): string {
  return JSON.stringify(canonicalValue(payload, new Set<object>()));
}

export function payloadHash(payload: unknown): { json: string; hash: string } {
  const json = canonicalPayload(payload);
  return { json, hash: createHash("sha256").update(json, "utf8").digest("hex") };
}

/** Durable boundary between state changes and all Notion side effects. */
export class NotionOutbox {
  constructor(
    private readonly client: Client,
    private readonly now: () => number = Date.now,
  ) {}

  async enqueue(input: EnqueueNotionOperation): Promise<EnqueueResult> {
    const encoded = payloadHash(input.payload);
    const inserted = await this.client.execute({
      sql: `INSERT INTO notion_outbox
              (card_id, priority, operation, target, payload, payload_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(target, payload_hash) DO NOTHING
            RETURNING id`,
      args: [
        input.cardId ?? null,
        input.priority,
        input.operation,
        input.target,
        encoded.json,
        encoded.hash,
        this.now(),
      ],
    });
    const insertedId = inserted.rows[0]?.id;
    if (insertedId !== undefined) {
      return { id: Number(insertedId), inserted: true, payloadHash: encoded.hash };
    }

    const existing = await this.client.execute({
      sql: `SELECT id, state, (SELECT MAX(id) FROM notion_outbox WHERE target = ?) AS newest
            FROM notion_outbox WHERE target = ? AND payload_hash = ?`,
      args: [input.target, input.target, encoded.hash],
    });
    const id = existing.rows[0]?.id;
    if (id === undefined) throw new Error("outbox conflict row disappeared");
    // Dedup exists for crash replay, so it may only collapse a payload that is
    // still the newest thing this target was given. Once a different payload
    // followed it, the remote holds that later one, and the recurrence is new
    // work: dropping it leaves the remote on the intermediate state for good.
    // A Story page that stopped and was then resumed by a person returns to
    // exactly the payload it had before it stopped, and the stop callout sat
    // on the page for the rest of the run.
    const superseded = Number(existing.rows[0]?.newest ?? id) !== Number(id);
    if ((input.resend || superseded) && existing.rows[0]?.state === "sent") {
      await this.client.execute({
        sql: `UPDATE notion_outbox
              SET state = 'pending', attempts = 0, last_error = NULL, sent_at = NULL,
                  next_attempt_at = NULL, created_at = ?, priority = ?
              WHERE id = ? AND state = 'sent'`,
        args: [this.now(), input.priority, id],
      });
      return { id: Number(id), inserted: true, payloadHash: encoded.hash };
    }
    return { id: Number(id), inserted: false, payloadHash: encoded.hash };
  }

  async replay(delivery: NotionOutboxDelivery, options: ReplayOptions = {}): Promise<ReplayResult> {
    const limit = options.limit ?? 100;
    const operations = options.operations ?? [];
    if (options.operations !== undefined && operations.length === 0) {
      throw new Error("an outbox replay must name at least one operation or none");
    }
    const filter = operations.length > 0 ? ` AND operation IN (${operations.map(() => "?").join(", ")})` : "";
    const now = this.now();
    const rows = (await this.client.execute({
      // Oldest desired state first, and a row revived by a recurring payload
      // carries the instant it was revived, so it lands after whatever was
      // queued for the same target in between.
      sql: `SELECT id, card_id, priority, operation, target, payload, payload_hash, attempts, created_at
            FROM notion_outbox
            WHERE state = 'pending' AND (claimed_until IS NULL OR claimed_until <= ?)
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)${filter}
            ORDER BY priority ASC, created_at ASC, id ASC
            LIMIT ?`,
      args: [now, now, ...operations, limit],
    })).rows;
    let sent = 0;
    let failed = 0;
    const dead: DeadLetter[] = [];
    const failures: OutboxFailure[] = [];

    for (const row of rows) {
      const record: NotionOutboxRecord = {
        id: Number(row.id),
        cardId: row.card_id === null ? null : String(row.card_id),
        priority: Number(row.priority),
        operation: String(row.operation),
        target: String(row.target),
        payload: JSON.parse(String(row.payload)) as unknown,
        payloadHash: String(row.payload_hash),
        attempts: Number(row.attempts) + 1,
      };
      // Claiming is what keeps two overlapping replays from both sending this
      // row. An operation that appends to a page cannot tell its own append
      // from somebody else's, so a lost race here shows up as a duplicated
      // block on a page a person reads, not as a retry.
      const claimed = await this.client.execute({
        sql: `UPDATE notion_outbox
              SET attempts = attempts + 1, last_error = NULL, claimed_until = ?
              WHERE id = ? AND state = 'pending' AND (claimed_until IS NULL OR claimed_until <= ?)`,
        args: [this.now() + OUTBOX_CLAIM_MS, record.id, this.now()],
      });
      if (claimed.rowsAffected === 0) continue;

      try {
        if (!(await delivery.isApplied(record))) await delivery.send(record);
        await this.client.execute({
          sql: `UPDATE notion_outbox
                SET state = 'sent', sent_at = ?, last_error = NULL,
                    claimed_until = NULL, next_attempt_at = NULL
                WHERE id = ?`,
          args: [this.now(), record.id],
        });
        sent++;
      } catch (cause) {
        const lastError = String((cause as Error).message).slice(0, 2_000);
        // A transient fault is not evidence about the payload, so it may not
        // spend the payload budget; it buys a pause instead, until the row has
        // been failing that way for longer than any outage worth waiting out.
        const transient = isTransientNotionFailure(cause);
        const waited = this.now() - Number(row.created_at);
        const exhausted = record.attempts >= OUTBOX_MAX_ATTEMPTS
          && (!transient || waited >= OUTBOX_TRANSIENT_WINDOW_MS);
        const nextAttemptAt = transient && !exhausted
          ? this.now() + transientBackoffMs(record.attempts)
          : null;
        await this.client.execute({
          sql: `UPDATE notion_outbox
                SET last_error = ?, state = ?, claimed_until = NULL, next_attempt_at = ?
                WHERE id = ?`,
          args: [lastError, exhausted ? "dead" : "pending", nextAttemptAt, record.id],
        });
        failed++;
        failures.push({ id: record.id, cardId: record.cardId, operation: record.operation, attempts: record.attempts, error: lastError });
        if (exhausted) {
          dead.push({
            id: record.id,
            cardId: record.cardId,
            operation: record.operation,
            target: record.target,
            attempts: record.attempts,
            lastError,
          });
        }
      }
    }

    return { sent, failed, failures, dead };
  }

  /**
   * Puts a row that gave up back in the queue so the next replay tries it
   * again.
   *
   * Only `dead` rows: a pending row is already coming, and a sent one must not
   * be sent again. Attempts are reset, because the person asking is answering
   * a question about this write ("check the save"), not extending the retry
   * budget that produced the failure.
   */
  async requeue(id: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE notion_outbox
            SET state = 'pending', attempts = 0, last_error = NULL, claimed_until = NULL, sent_at = NULL
            WHERE id = ? AND state = 'dead'`,
      args: [id],
    });
    return result.rowsAffected > 0;
  }
}

/** Rows that gave up, newest first, for the operator log and inspect scripts. */
export async function deadLetters(client: Client, limit = 50): Promise<DeadLetter[]> {
  const rows = (await client.execute({
    sql: `SELECT id, card_id, operation, target, attempts, last_error
          FROM notion_outbox WHERE state = 'dead' ORDER BY id DESC LIMIT ?`,
    args: [limit],
  })).rows;
  return rows.map((row) => ({
    id: Number(row.id),
    cardId: row.card_id === null ? null : String(row.card_id),
    operation: String(row.operation),
    target: String(row.target),
    attempts: Number(row.attempts),
    lastError: row.last_error === null ? null : String(row.last_error),
  }));
}
