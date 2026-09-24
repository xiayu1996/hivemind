/**
 * The process's single client for the Notion API, over plain fetch.
 *
 * Create one per process and hand it to everything that talks to Notion: it
 * owns the rate budget (Notion allows an average of three requests per second
 * per integration and answers bursts with 429), and two instances would each
 * spend all of it.
 *
 * Only a read is sent again after a fault that says nothing about the payload
 * (a 5xx, a timeout, a reset connection, a failed DNS lookup). A write that
 * timed out may already have landed, and appending children is not
 * idempotent: sending it again is how a page grows a duplicate block. A 429 is
 * the exception for every method, because Notion refuses a rate-limited
 * request before doing any of it; its Retry-After holds every request in the
 * process, not only the one that drew it.
 */

export const NOTION_VERSION = "2025-09-03";

const API_ORIGIN = "https://api.notion.com";

export interface NotionRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path and query under the API origin, such as `/v1/blocks/{id}/children?page_size=100`. */
  path: string;
  body?: unknown;
}

/** Resolves with the parsed body of a 2xx answer and rejects with a NotionError otherwise. */
export type NotionTransport = (request: NotionRequest) => Promise<unknown>;

export class NotionError extends Error {
  /** The HTTP status, or null when no answer arrived. */
  readonly status: number | null;
  /** Notion's error code (`object_not_found`, `validation_error`), or the network fault's code. */
  readonly code: string | null;

  constructor(message: string, status: number | null, code: string | null, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotionError";
    this.status = status;
    this.code = code;
  }
}

export interface NotionTransportOptions {
  /** The integration token. It travels as a header and never appears in an error. */
  token: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Requests per second for the whole process. */
  ratePerSecond?: number;
  /** Sends of one request, the first one included. */
  attempts?: number;
  /** Pause before a read is sent again, multiplied by the attempt number. */
  retryBackoffMs?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  // undici's names for a socket the other side closed and for its own timeouts.
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** What a failed fetch says went wrong. undici throws "fetch failed" and keeps
 * the fault in `cause`; the request timeout surfaces as a TimeoutError. */
function faultCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    if ("name" in current && current.name === "TimeoutError") return "TimeoutError";
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return null;
}

function isTransient(code: string | null): boolean {
  return code === "TimeoutError" || (code !== null && TRANSIENT_CODES.has(code));
}

interface Bucket {
  take(): Promise<void>;
  /** Holds every later `take` for at least this long. */
  pause(milliseconds: number): void;
}

/** One token at most, so requests are spaced evenly rather than burst. Takes
 * are served in order through a promise chain. */
function createBucket(ratePerSecond: number, now: () => number, sleep: (ms: number) => Promise<void>): Bucket {
  let tokens = 1;
  let refilledAt = now();
  let pausedUntil = Number.NEGATIVE_INFINITY;
  let queue: Promise<void> = Promise.resolve();

  const acquire = async (): Promise<void> => {
    for (;;) {
      const time = now();
      if (time < pausedUntil) {
        await sleep(pausedUntil - time);
        continue;
      }
      tokens = Math.min(1, tokens + ((time - refilledAt) / 1_000) * ratePerSecond);
      refilledAt = time;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - tokens) / ratePerSecond) * 1_000));
    }
  };

  return {
    take() {
      const turn = queue.then(acquire);
      // Only an injected sleep can reject; the caller whose turn it was sees
      // that rejection, and the chain must not stay broken for the next one.
      queue = turn.catch(() => undefined);
      return turn;
    },
    pause(milliseconds) {
      pausedUntil = Math.max(pausedUntil, now() + milliseconds);
    },
  };
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

async function readBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A proxy in front of the API answers an outage with HTML. The status
    // still decides what happens; the start of the page says whose it was.
    return { message: `non-JSON response: ${raw.slice(0, 200)}` };
  }
}

function describeError(data: unknown): { code: string | null; message: string } {
  if (typeof data !== "object" || data === null) return { code: null, message: String(data) };
  const code = "code" in data && typeof data.code === "string" ? data.code : null;
  const message = "message" in data && typeof data.message === "string"
    ? data.message
    : JSON.stringify(data).slice(0, 400);
  return { code, message };
}

/**
 * Archiving a block Notion has already archived answers 400 "Can't edit block
 * that is archived". The block is in the state the caller asked for, so the
 * refusal is success; left thrown, every retry of it fails the same way.
 */
function archivesArchivedBlock(request: NotionRequest, status: number, message: string): boolean {
  if (status !== 400 || request.method !== "PATCH" || !/^\/v1\/blocks\/[^/?]+$/.test(request.path)) return false;
  const body = request.body;
  const archiving = typeof body === "object" && body !== null
    && (("archived" in body && body.archived === true) || ("in_trash" in body && body.in_trash === true));
  return archiving && /block that is archived/i.test(message);
}

export function createNotionTransport(options: NotionTransportOptions): NotionTransport {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, options.attempts ?? 3);
  const backoffMs = options.retryBackoffMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = (options.baseUrl ?? API_ORIGIN).replace(/\/$/, "");
  const ratePerSecond = options.ratePerSecond ?? 2.5;
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new Error("ratePerSecond must be a positive finite number");
  }
  const bucket = createBucket(ratePerSecond, now, sleep);

  return async (request) => {
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    const init: RequestInit = {
      method: request.method,
      headers: {
        authorization: `Bearer ${options.token}`,
        "notion-version": NOTION_VERSION,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    };
    const read = request.method === "GET";

    for (let attempt = 1; ; attempt++) {
      await bucket.take();
      let status: number;
      let data: unknown;
      let wait: number | null;
      try {
        const response = await send(`${baseUrl}${request.path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        status = response.status;
        wait = retryAfterMs(response);
        data = await readBody(response);
      } catch (cause) {
        const code = faultCode(cause);
        if (read && attempt < attempts && isTransient(code)) {
          await sleep(backoffMs * attempt);
          continue;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new NotionError(`${request.method} ${request.path} failed: ${message}`, null, code, { cause });
      }

      if (status >= 200 && status < 300) return data;
      if (status === 429 && attempt < attempts) {
        bucket.pause(wait ?? backoffMs * attempt);
        continue;
      }
      if (status >= 500 && read && attempt < attempts) {
        await sleep(backoffMs * attempt);
        continue;
      }
      const detail = describeError(data);
      if (archivesArchivedBlock(request, status, detail.message)) return data;
      // Notion names the offending field in the message; the start of what
      // was sent says which of many similar writes it was. Neither carries
      // the token.
      const sent = body === undefined ? "" : ` (request body: ${body.slice(0, 300)})`;
      throw new NotionError(
        `${request.method} ${request.path} failed with status ${status}${detail.code ? ` ${detail.code}` : ""}: ${detail.message}${sent}`,
        status,
        detail.code,
      );
    }
  };
}
