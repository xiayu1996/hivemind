import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotionSyncCoordinator,
  verifyNotionWebhookSignature,
  type NotionSyncPoller,
} from "./sync.js";

afterEach(() => vi.useRealTimers());

describe("webhook verification", () => {
  it("accepts the exact HMAC and rejects changed content", () => {
    const secret = "webhook-secret";
    const body = Buffer.from('{"type":"comment.created"}');
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyNotionWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyNotionWebhookSignature(Buffer.from("changed"), signature, secret)).toBe(false);
  });
});

describe("NotionSyncCoordinator", () => {
  it("uses a webhook only as an immediate poll signal", async () => {
    const calls: string[] = [];
    const poller: NotionSyncPoller = {
      pollProperties: async (pageId) => { calls.push(`properties:${pageId}`); },
      pollContent: async (pageId) => { calls.push(`content:${pageId}`); },
      pollComments: async (pageId) => { calls.push(`comments:${pageId}`); },
    };
    const sync = new NotionSyncCoordinator(poller);
    sync.registerActivePage("page-1");
    await sync.handleWebhook({ id: "event-1", type: "comment.created", pageId: "page-1" });
    expect(calls).toEqual(["comments:page-1"]);
    await sync.handleWebhook({ id: "event-1", type: "comment.created", pageId: "page-1" });
    expect(calls).toHaveLength(1);
  });

  it("converges properties, content and comments on the 60 second fallback without webhooks", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const poller: NotionSyncPoller = {
      pollProperties: async (pageId) => { calls.push(`properties:${pageId}`); },
      pollContent: async (pageId) => { calls.push(`content:${pageId}`); },
      pollComments: async (pageId) => { calls.push(`comments:${pageId}`); },
    };
    const sync = new NotionSyncCoordinator(poller, { intervalMs: 60_000 });
    sync.registerActivePage("page-2");
    sync.registerActivePage("page-1");
    sync.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await sync.waitForIdle();
    sync.stop();
    expect(calls).toEqual([
      "properties:page-1", "content:page-1", "comments:page-1",
      "properties:page-2", "content:page-2", "comments:page-2",
    ]);
  });
});
