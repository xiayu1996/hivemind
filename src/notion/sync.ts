import { createHmac, timingSafeEqual } from "node:crypto";

export type NotionWebhookType =
  | "page.created"
  | "page.properties_updated"
  | "page.content_updated"
  | "comment.created";

export interface NotionWebhookEvent {
  id: string;
  type: NotionWebhookType;
  pageId: string;
}

export interface NotionSyncPoller {
  pollProperties(pageId: string): Promise<void>;
  pollContent(pageId: string): Promise<void>;
  pollComments(pageId: string): Promise<void>;
}

export interface NotionSyncOptions {
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export function verifyNotionWebhookSignature(
  body: Buffer,
  suppliedSignature: string,
  secret: string,
): boolean {
  const supplied = suppliedSignature.startsWith("sha256=") ? suppliedSignature.slice(7) : suppliedSignature;
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeEqual(Buffer.from(supplied.toLowerCase(), "hex"), Buffer.from(expected, "hex"));
}

/** Webhooks accelerate polling; the active-set cycle remains the guarantee. */
export class NotionSyncCoordinator {
  readonly #activePages = new Set<string>();
  readonly #seenEvents = new Set<string>();
  readonly #eventOrder: string[] = [];
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #cycle: Promise<void> | undefined;

  constructor(
    private readonly poller: NotionSyncPoller,
    options: NotionSyncOptions = {},
  ) {
    this.#intervalMs = options.intervalMs ?? 60_000;
    this.#onError = options.onError ?? ((error) => console.error("Notion fallback poll failed", error));
    if (!Number.isFinite(this.#intervalMs) || this.#intervalMs <= 0) {
      throw new Error("intervalMs must be a positive finite number");
    }
  }

  registerActivePage(pageId: string): void {
    this.#activePages.add(pageId);
  }

  unregisterActivePage(pageId: string): void {
    this.#activePages.delete(pageId);
  }

  async handleWebhook(event: NotionWebhookEvent): Promise<void> {
    if (this.#seenEvents.has(event.id)) return;
    this.#seenEvents.add(event.id);
    this.#eventOrder.push(event.id);
    if (this.#eventOrder.length > 10_000) {
      const expired = this.#eventOrder.shift();
      if (expired) this.#seenEvents.delete(expired);
    }
    this.registerActivePage(event.pageId);

    switch (event.type) {
      case "page.created":
      case "page.properties_updated":
        await this.poller.pollProperties(event.pageId);
        break;
      case "page.content_updated":
        await this.poller.pollContent(event.pageId);
        break;
      case "comment.created":
        await this.poller.pollComments(event.pageId);
        break;
    }
  }

  async runFallbackOnce(): Promise<void> {
    for (const pageId of [...this.#activePages].toSorted((a, b) => a.localeCompare(b, "en"))) {
      await this.poller.pollProperties(pageId);
      await this.poller.pollContent(pageId);
      await this.poller.pollComments(pageId);
    }
  }

  start(): void {
    if (this.#timer) throw new Error("Notion sync is already started");
    this.#timer = setInterval(() => {
      if (this.#cycle) return;
      this.#cycle = this.runFallbackOnce()
        .catch(this.#onError)
        .finally(() => { this.#cycle = undefined; });
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async waitForIdle(): Promise<void> {
    await this.#cycle;
  }
}
