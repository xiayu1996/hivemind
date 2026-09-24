import { describe, expect, it, vi } from "vitest";
import { AlertRouter, EmailAlertChannel, FeishuWebhookChannel, type AlertChannel } from "./index.js";

describe("alert side channel", () => {
  it("fans needs_input out independently and reports partial channel failure", async () => {
    const delivered: string[] = [];
    const channels: AlertChannel[] = [
      { name: "ok", send: async () => { delivered.push("ok"); } },
      { name: "down", send: async () => { throw new Error("smtp unavailable"); } },
    ];
    const result = await new AlertRouter(channels).send({ kind: "needs_input", title: "Question", body: "Please answer" });
    expect(delivered).toEqual(["ok"]);
    expect(result.delivered).toEqual(["ok"]);
    expect(result.failed).toEqual([{ channel: "down", reason: "smtp unavailable" }]);
  });

  it("does not send non-critical informational messages", async () => {
    const send = vi.fn(async () => undefined);
    const result = await new AlertRouter([{ name: "channel", send }]).send({ kind: "info", title: "x", body: "y" });
    expect(result.attempted).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("uses the Feishu text webhook contract", async () => {
    let body = "";
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    });
    await new FeishuWebhookChannel("https://example.invalid/hook", request).send({
      kind: "p0", title: "Worker offline", body: "No healthy host", cardId: "card-1",
    });
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(body)).toMatchObject({ msg_type: "text" });
  });

  it("uses SMTP without exposing credentials in the message", async () => {
    const sendMail = vi.fn(async () => ({ accepted: ["ops@example.invalid"] }));
    const channel = new EmailAlertChannel({ sendMail } as never, {
      from: "hivemind@example.invalid", to: ["ops@example.invalid"],
    });
    await channel.send({ kind: "p0", title: "Failure", body: "Investigate" });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: "[hivemind:p0] Failure" }));
  });
});
