import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

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

const webhookEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  entity: z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough(),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

const SUPPORTED_WEBHOOK_TYPES = new Set<NotionWebhookType>([
  "page.created",
  "page.properties_updated",
  "page.content_updated",
  "comment.created",
]);

export type NotionWebhookRequestResult =
  | { status: 200; accepted: true }
  | { status: 202; accepted: false; reason: "unsupported_event" }
  | { status: 400; accepted: false; reason: "invalid_payload" }
  | { status: 401; accepted: false; reason: "invalid_signature" };

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

/** Validates and maps the current Notion webhook envelope into a poll signal. */
export async function handleNotionWebhookRequest(
  body: Buffer,
  suppliedSignature: string,
  secret: string,
  coordinator: Pick<NotionSyncCoordinator, "handleWebhook">,
): Promise<NotionWebhookRequestResult> {
  if (!verifyNotionWebhookSignature(body, suppliedSignature, secret)) {
    return { status: 401, accepted: false, reason: "invalid_signature" };
  }
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, accepted: false, reason: "invalid_payload" };
  }
  const parsed = webhookEnvelopeSchema.safeParse(json);
  if (!parsed.success) return { status: 400, accepted: false, reason: "invalid_payload" };
  if (!SUPPORTED_WEBHOOK_TYPES.has(parsed.data.type as NotionWebhookType)) {
    return { status: 202, accepted: false, reason: "unsupported_event" };
  }
  const type = parsed.data.type as NotionWebhookType;
  const pageId = type === "comment.created"
    ? parsed.data.data.page_id
    : parsed.data.entity.type === "page" ? parsed.data.entity.id : undefined;
  if (typeof pageId !== "string" || pageId.length === 0) {
    return { status: 400, accepted: false, reason: "invalid_payload" };
  }
  await coordinator.handleWebhook({ id: parsed.data.id, type, pageId });
  return { status: 200, accepted: true };
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
