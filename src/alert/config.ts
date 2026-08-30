import {
  EmailAlertChannel,
  FeishuWebhookChannel,
  type AlertChannel,
} from "./index.js";

export type AlertConfiguration = ReadonlyMap<string, string>;

function configured(
  values: AlertConfiguration,
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = environment[key] ?? values.get(key);
  return value?.trim() ? value.trim() : undefined;
}

/** Builds the out-of-band channels without exposing their credentials. */
export function alertChannelsFromConfig(
  values: AlertConfiguration,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AlertChannel[] {
  const channels: AlertChannel[] = [];
  const webhook = configured(values, environment, "FEISHU_WEBHOOK_URL");
  if (webhook) channels.push(new FeishuWebhookChannel(webhook));

  const host = configured(values, environment, "SMTP_HOST");
  const smtpKeys = ["SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", "SMTP_TO"] as const;
  const smtpValues = Object.fromEntries(smtpKeys.map((key) => [key, configured(values, environment, key)]));
  if (host || smtpKeys.some((key) => smtpValues[key])) {
    if (!host || smtpKeys.some((key) => !smtpValues[key])) {
      throw new Error("SMTP configuration is incomplete");
    }
    const portText = configured(values, environment, "SMTP_PORT") ?? "587";
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SMTP_PORT is invalid");
    const secureText = configured(values, environment, "SMTP_SECURE") ?? "false";
    if (secureText !== "true" && secureText !== "false") throw new Error("SMTP_SECURE must be true or false");
    const recipients = smtpValues.SMTP_TO!.split(",").map((item) => item.trim()).filter(Boolean);
    if (recipients.length === 0) throw new Error("SMTP_TO has no recipient");
    channels.push(EmailAlertChannel.smtp({
      host,
      port,
      secure: secureText === "true",
      user: smtpValues.SMTP_USER!,
      password: smtpValues.SMTP_PASSWORD!,
    }, {
      from: smtpValues.SMTP_FROM!,
      to: recipients,
    }));
  }
  return channels;
}
