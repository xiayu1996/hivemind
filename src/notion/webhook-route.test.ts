import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerNotionWebhookRoute } from "./webhook-route.js";

describe("Notion webhook HTTP route", () => {
  const secret = "verification-token";
  const sign = (body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("verifies the exact request bytes before dispatching an official event", async () => {
    const handleWebhook = vi.fn(async () => undefined);
    const app = Fastify({ logger: false });
    await registerNotionWebhookRoute(app, { secret, coordinator: { handleWebhook } });
    const payload = '{ "id": "event-1", "type": "comment.created", "entity": {"type":"comment","id":"comment-1"}, "data": {"page_id":"page-1"} }';

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: {
        "content-type": "application/json",
        "x-notion-signature": sign(payload),
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 200, accepted: true });
    expect(handleWebhook).toHaveBeenCalledWith({
      id: "event-1",
      type: "comment.created",
      pageId: "page-1",
    });
    await app.close();
  });

  it("rejects a signature computed over different bytes", async () => {
    const handleWebhook = vi.fn(async () => undefined);
    const app = Fastify({ logger: false });
    await registerNotionWebhookRoute(app, { secret, coordinator: { handleWebhook } });
    const payload = JSON.stringify({
      id: "event-2",
      type: "page.content_updated",
      entity: { type: "page", id: "page-2" },
      data: {},
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: {
        "content-type": "application/json",
        "x-notion-signature": sign(`${payload}\n`),
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects requests without the signature header", async () => {
    const app = Fastify({ logger: false });
    await registerNotionWebhookRoute(app, {
      secret,
      coordinator: { handleWebhook: vi.fn(async () => undefined) },
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/notion",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ accepted: false, reason: "invalid_request" });
    await app.close();
  });
});
