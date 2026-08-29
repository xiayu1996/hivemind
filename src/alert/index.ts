import nodemailer, { type Transporter } from "nodemailer";
import { redactForExport } from "../observability/redact.js";

export type AlertKind = "needs_input" | "p0" | "info";

export interface AlertMessage {
  kind: AlertKind;
  title: string;
  body: string;
  cardId?: string;
  url?: string;
}

export interface AlertChannel {
  name: string;
  send(message: AlertMessage): Promise<void>;
}

export interface AlertDelivery {
  attempted: string[];
  delivered: string[];
  failed: Array<{ channel: string; reason: string }>;
}

/** Sends critical control-plane alerts independently of the Notion gateway. */
export class AlertRouter {
  constructor(private readonly channels: readonly AlertChannel[]) {}

  async send(message: AlertMessage): Promise<AlertDelivery> {
    if (message.kind !== "needs_input" && message.kind !== "p0") {
      return { attempted: [], delivered: [], failed: [] };
    }
    const safe = redactForExport(message);
    const settled = await Promise.allSettled(this.channels.map((channel) => channel.send(safe)));
    const delivery: AlertDelivery = { attempted: this.channels.map((channel) => channel.name), delivered: [], failed: [] };
    for (const [index, result] of settled.entries()) {
      const channel = this.channels[index]!;
      if (result.status === "fulfilled") delivery.delivered.push(channel.name);
      else delivery.failed.push({
        channel: channel.name,
        reason: result.reason instanceof Error ? result.reason.message : "alert delivery failed",
      });
    }
    return delivery;
  }
}

export class FeishuWebhookChannel implements AlertChannel {
  readonly name = "feishu";

  constructor(
    private readonly webhookUrl: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async send(message: AlertMessage): Promise<void> {
    const details = [message.body, message.cardId ? `Card: ${message.cardId}` : "", message.url ?? ""]
      .filter(Boolean)
      .join("\n");
    const response = await this.request(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text: `${message.title}\n${details}` } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Feishu webhook returned HTTP ${response.status}`);
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = body.code ?? body.StatusCode;
    if (code !== undefined && Number(code) !== 0) throw new Error("Feishu webhook rejected the alert");
  }
}

export interface EmailChannelConfig {
  from: string;
  to: string[];
}

export class EmailAlertChannel implements AlertChannel {
  readonly name = "email";

  constructor(
    private readonly transport: Transporter,
    private readonly config: EmailChannelConfig,
  ) {}

  static smtp(
    smtp: { host: string; port: number; secure: boolean; user: string; password: string },
    config: EmailChannelConfig,
  ): EmailAlertChannel {
    return new EmailAlertChannel(nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.password },
    }), config);
  }

  async send(message: AlertMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.from,
      to: this.config.to.join(","),
      subject: `[hivemind:${message.kind}] ${message.title}`,
      text: [message.body, message.cardId ? `Card: ${message.cardId}` : "", message.url ?? ""].filter(Boolean).join("\n"),
    });
  }
}
