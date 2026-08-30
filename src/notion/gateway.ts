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
}

export interface PagePropertyUpdate {
  pageId: string;
  properties: Record<string, unknown>;
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

interface PendingRequest {
  seq: number;
  request: NotionRequest;
  resolve: (response: NotionTransportResponse) => void;
  reject: (error: unknown) => void;
}

interface PropertyBatch {
  properties: Record<string, unknown>;
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
        existing.fingerprint = update.fingerprint;
        existing.callers.push({ resolve, reject });
        return;
      }

      const timer = setTimeout(() => void this.#flushPropertyBatch(update.pageId), this.#mergeWindowMs);
      this.#propertyBatches.set(update.pageId, {
        properties: { ...update.properties },
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

  async #sendWithRetry(request: NotionRequest): Promise<NotionTransportResponse> {
    let response = await this.#transport(request);
    while (response.status === 429) {
      const retryAfterSeconds = response.retryAfterSeconds ?? 1;
      await sleep(Math.max(0, retryAfterSeconds) * 1_000);
      while (!this.#tryTakeToken()) await sleep(this.#millisecondsUntilToken());
      response = await this.#transport(request);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new NotionGatewayError(`${request.method} ${request.path} failed with status ${response.status}`, response.status);
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
        body: { properties: batch.properties },
      });
      this.#successfulFingerprints.set(pageId, batch.fingerprint);
      for (const caller of batch.callers) caller.resolve({ skipped: false, response });
    } catch (cause) {
      for (const caller of batch.callers) caller.reject(cause);
    }
  }
}
