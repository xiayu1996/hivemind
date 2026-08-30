import { describe, expect, it } from "vitest";
import { alertChannelsFromConfig } from "./config.js";

describe("alertChannelsFromConfig", () => {
  it("builds only the configured channels", () => {
    const channels = alertChannelsFromConfig(new Map([
      ["FEISHU_WEBHOOK_URL", "https://example.invalid/hook"],
      ["SMTP_HOST", "smtp.example.invalid"],
      ["SMTP_USER", "worker"],
      ["SMTP_PASSWORD", "password"],
      ["SMTP_FROM", "worker@example.invalid"],
      ["SMTP_TO", "operator@example.invalid"],
    ]), {});
    expect(channels.map((channel) => channel.name)).toEqual(["feishu", "email"]);
  });

  it("rejects a partial SMTP credential instead of silently disabling alerts", () => {
    expect(() => alertChannelsFromConfig(new Map([
      ["SMTP_HOST", "smtp.example.invalid"],
      ["SMTP_USER", "worker"],
    ]), {})).toThrow("SMTP configuration is incomplete");
  });
});
