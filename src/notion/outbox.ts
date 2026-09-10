import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";

export interface EnqueueNotionOperation {
  cardId?: string;
  priority: number;
  operation: string;
  target: string;
  payload: unknown;
  /**
   * The same payload was delivered before, but the remote has since moved on
   * and must receive it again. Dedup exists for crash replay; a desired state
   * that recurs after an intermediate one is new work, not a replay.
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
 * How many delivery attempts a row gets before it is declared dead. Notion
 * outages clear within a few cycles; a row still failing after this many is
 * a payload the API will never accept, and retrying it forever only hides
 * the failure while it holds its place in the queue.
 */
export const OUTBOX_MAX_ATTEMPTS = 8;

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
      sql: "SELECT id, state FROM notion_outbox WHERE target = ? AND payload_hash = ?",
      args: [input.target, encoded.hash],
    });
    const id = existing.rows[0]?.id;
    if (id === undefined) throw new Error("outbox conflict row disappeared");
    if (input.resend && existing.rows[0]?.state === "sent") {
      await this.client.execute({
        sql: `UPDATE notion_outbox
              SET state = 'pending', attempts = 0, last_error = NULL, sent_at = NULL, created_at = ?, priority = ?
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
    const rows = (await this.client.execute({
      sql: `SELECT id, card_id, priority, operation, target, payload, payload_hash, attempts
            FROM notion_outbox
            WHERE state = 'pending'${filter}
            ORDER BY priority ASC, id ASC
            LIMIT ?`,
      args: [...operations, limit],
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
      await this.client.execute({
        sql: "UPDATE notion_outbox SET attempts = attempts + 1, last_error = NULL WHERE id = ?",
        args: [record.id],
      });

      try {
        if (!(await delivery.isApplied(record))) await delivery.send(record);
        await this.client.execute({
          sql: "UPDATE notion_outbox SET state = 'sent', sent_at = ?, last_error = NULL WHERE id = ?",
          args: [this.now(), record.id],
        });
        sent++;
      } catch (cause) {
        const lastError = String((cause as Error).message).slice(0, 2_000);
        const exhausted = record.attempts >= OUTBOX_MAX_ATTEMPTS;
        await this.client.execute({
          sql: "UPDATE notion_outbox SET last_error = ?, state = ? WHERE id = ?",
          args: [lastError, exhausted ? "dead" : "pending", record.id],
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
