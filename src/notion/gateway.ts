export type NotionPriority = "interaction" | "status" | "report" | "projection";

const PRIORITY_ORDER: Record<NotionPriority, number> = {
  interaction: 0,
  status: 1,
  report: 2,
  projection: 3,
};

export interface NotionRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  priority: NotionPriority;
  body?: unknown;
}

export interface NotionTransportResponse<T = unknown> {
  status: number;
  data: T;
  retryAfterSeconds?: number;
}

export type NotionTransport = (request: NotionRequest) => Promise<NotionTransportResponse>;

export interface NotionGatewayOptions {
  transport: NotionTransport;
  ratePerSecond?: number;
  mergeWindowMs?: number;
  /** Pause before sending a read again after a transient fault. */
  readRetryBackoffMs?: number;
}

export interface PagePropertyUpdate {
  pageId: string;
  properties: Record<string, unknown>;
  /** The emoji on the page's tab and in every list that shows it, which says
   * at a glance whether the card wants a person. It rides with the properties
   * so the same human-wins window covers both. */
  icon?: string;
  fingerprint: string;
  /** Fingerprint currently observed on the Notion page. */
  currentFingerprint?: string;
}

export interface PropertyUpdateResult {
  skipped: boolean;
  response?: NotionTransportResponse;
}

export class NotionGatewayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "NotionGatewayError";
  }
}

/**
 * How many times a read is sent before its fault is handed to the caller.
 * Only reads: appending children is not idempotent, so a write that timed out
 * may already have landed and sending it again would duplicate a block.
 */
const READ_ATTEMPTS = 3;

/** Faults that say nothing about the payload: the request never got an answer,
 * or got one Notion itself calls temporary. Anything else -- a 400 the API will
 * refuse forever, a parse error, a bug -- is not transient, so an error nobody
 * recognises is reported rather than retried until a budget runs out. */
export function isTransientNotionFailure(error: unknown): boolean {
  if (error instanceof NotionGatewayError && error.status !== undefined) {
    return error.status >= 500 || error.status === 429;
  }
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = String((error as Error | null)?.message ?? "");
  return /aborted due to timeout|fetch failed|socket hang up|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE/i
    .test(message);
}

/**
 * Archiving a block Notion has already archived answers 400 "Can't edit block
 * that is archived". The state the caller asked for is the state the block is
 * in, so the refusal is success; left thrown it fails the projection entry on
 * every retry until the outbox declares it dead and the page stops updating.
 */
export async function archiveBlock(
  request: (input: NotionRequest) => Promise<NotionTransportResponse>,
  blockId: string,
): Promise<void> {
  try {
    await request({
      method: "PATCH",
      path: `/v1/blocks/${encodeURIComponent(blockId)}`,
      priority: "projection",
      body: { archived: true },
    });
  } catch (error) {
    if (!/block that is archived/i.test((error as Error).message)) throw error;
  }
}

interface PendingRequest {
  seq: number;
  request: NotionRequest;
  resolve: (response: NotionTransportResponse) => void;
  reject: (error: unknown) => void;
}

interface PropertyBatch {
  properties: Record<string, unknown>;
  icon?: string;
  fingerprint: string;
  callers: Array<{
    resolve: (result: PropertyUpdateResult) => void;
    reject: (error: unknown) => void;
  }>;
  timer: ReturnType<typeof setTimeout>;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * The orchestrator's single Notion I/O boundary: one global rate bucket, one
 * priority queue, one retry policy and one property-write coalescer.
 */
export class NotionGateway {
  readonly #transport: NotionTransport;
  readonly #ratePerSecond: number;
  readonly #mergeWindowMs: number;
  readonly #readRetryBackoffMs: number;
  readonly #queue: PendingRequest[] = [];
  readonly #propertyBatches = new Map<string, PropertyBatch>();
  readonly #successfulFingerprints = new Map<string, string>();
  #tokens = 1;
  #lastRefill = Date.now();
  #nextSeq = 1;
  #draining = false;

  constructor(options: NotionGatewayOptions) {
    this.#transport = options.transport;
    this.#ratePerSecond = options.ratePerSecond ?? 2.5;
    this.#mergeWindowMs = options.mergeWindowMs ?? 5_000;
    this.#readRetryBackoffMs = options.readRetryBackoffMs ?? 1_000;
    if (!Number.isFinite(this.#ratePerSecond) || this.#ratePerSecond <= 0) {
      throw new NotionGatewayError("ratePerSecond must be a positive finite number");
    }
    if (!Number.isFinite(this.#mergeWindowMs) || this.#mergeWindowMs < 0) {
      throw new NotionGatewayError("mergeWindowMs must be a non-negative finite number");
    }
  }

  request(request: NotionRequest): Promise<NotionTransportResponse> {
    return new Promise((resolve, reject) => {
      this.#queue.push({ seq: this.#nextSeq++, request, resolve, reject });
      void this.#drain();
    });
  }

  updatePageProperties(update: PagePropertyUpdate): Promise<PropertyUpdateResult> {
    const known = update.currentFingerprint ?? this.#successfulFingerprints.get(update.pageId);
    if (known === update.fingerprint) return Promise.resolve({ skipped: true });

    return new Promise((resolve, reject) => {
      const existing = this.#propertyBatches.get(update.pageId);
      if (existing) {
        Object.assign(existing.properties, update.properties);
        if (update.icon) existing.icon = update.icon;
        existing.fingerprint = update.fingerprint;
        existing.callers.push({ resolve, reject });
        return;
      }

      const timer = setTimeout(() => void this.#flushPropertyBatch(update.pageId), this.#mergeWindowMs);
      this.#propertyBatches.set(update.pageId, {
        properties: { ...update.properties },
        ...(update.icon ? { icon: update.icon } : {}),
        fingerprint: update.fingerprint,
        callers: [{ resolve, reject }],
        timer,
      });
    });
  }

  #refill(): void {
    const now = Date.now();
    const elapsedSeconds = Math.max(0, now - this.#lastRefill) / 1_000;
    this.#tokens = Math.min(1, this.#tokens + elapsedSeconds * this.#ratePerSecond);
    this.#lastRefill = now;
  }

  #tryTakeToken(): boolean {
    this.#refill();
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  #millisecondsUntilToken(): number {
    this.#refill();
    return Math.max(1, Math.ceil(((1 - this.#tokens) / this.#ratePerSecond) * 1_000));
  }

  #takeNext(): PendingRequest {
    let selected = 0;
    for (let index = 1; index < this.#queue.length; index++) {
      const candidate = this.#queue[index]!;
      const current = this.#queue[selected]!;
      const priority = PRIORITY_ORDER[candidate.request.priority] - PRIORITY_ORDER[current.request.priority];
      if (priority < 0 || (priority === 0 && candidate.seq < current.seq)) selected = index;
    }
    return this.#queue.splice(selected, 1)[0]!;
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        if (!this.#tryTakeToken()) {
          await sleep(this.#millisecondsUntilToken());
          continue;
        }
        const pending = this.#takeNext();
        try {
          pending.resolve(await this.#sendWithRetry(pending.request));
        } catch (cause) {
          pending.reject(cause);
        }
      }
    } finally {
      this.#draining = false;
      if (this.#queue.length > 0) void this.#drain();
    }
  }

  /** One send, with a read given another go at a fault that says nothing about
   * what was asked. A page projection is dozens of reads around a few writes,
   * and without this a single timed-out read throws away the whole pass. */
  async #send(request: NotionRequest): Promise<NotionTransportResponse> {
    const attempts = request.method === "GET" ? READ_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.#transport(request);
        if (response.status < 500 || attempt >= attempts) return response;
      } catch (cause) {
        if (attempt >= attempts || !isTransientNotionFailure(cause)) throw cause;
      }
      await sleep(this.#readRetryBackoffMs * attempt);
      while (!this.#tryTakeToken()) await sleep(this.#millisecondsUntilToken());
    }
  }

  async #sendWithRetry(request: NotionRequest): Promise<NotionTransportResponse> {
    let response = await this.#send(request);
    while (response.status === 429) {
      const retryAfterSeconds = response.retryAfterSeconds ?? 1;
      await sleep(Math.max(0, retryAfterSeconds) * 1_000);
      while (!this.#tryTakeToken()) await sleep(this.#millisecondsUntilToken());
      response = await this.#send(request);
    }
    if (response.status < 200 || response.status >= 300) {
      // Notion says why in the body; without it a 400 in the outbox is a
      // number nobody can act on. The body carries no credential.
      const detail = response.data === undefined ? "" : `: ${JSON.stringify(response.data).slice(0, 400)}`;
      const sent = request.body === undefined ? "" : ` (request body: ${JSON.stringify(request.body).slice(0, 300)})`;
      throw new NotionGatewayError(`${request.method} ${request.path} failed with status ${response.status}${detail}${sent}`, response.status);
    }
    return response;
  }

  async #flushPropertyBatch(pageId: string): Promise<void> {
    const batch = this.#propertyBatches.get(pageId);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.#propertyBatches.delete(pageId);
    try {
      const response = await this.request({
        method: "PATCH",
        path: `/v1/pages/${encodeURIComponent(pageId)}`,
        priority: "status",
        body: {
          properties: batch.properties,
          ...(batch.icon ? { icon: { type: "emoji", emoji: batch.icon } } : {}),
        },
      });
      this.#successfulFingerprints.set(pageId, batch.fingerprint);
      for (const caller of batch.callers) caller.resolve({ skipped: false, response });
    } catch (cause) {
      for (const caller of batch.callers) caller.reject(cause);
    }
  }
}
