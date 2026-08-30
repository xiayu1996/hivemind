import type { ConfigStore } from "../config/store.js";
import type { AlertRouter } from "./index.js";

/**
 * A Notion @mention created through the API raises no push notification, so the
 * board is a place to read state, not a place to be told about it. Without an
 * out-of-band channel a `needs_input` stop reaches nobody until someone happens
 * to look, which for a 7x24 service means it reaches nobody.
 */
export async function assertOutOfBandChannel(
  alerts: AlertRouter,
  config: ConfigStore,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  if (alerts.channelCount > 0) return;
  await config.reload();
  if (!config.get("alert.requireOutOfBandChannel")) {
    warn("WARNING: running with no out-of-band alert channel. A needs_input stop will reach nobody; " +
      "alert.requireOutOfBandChannel is off.");
    return;
  }
  throw new Error(
    "no out-of-band alert channel is configured (FEISHU_WEBHOOK_URL or SMTP_*). " +
    "A Notion mention raises no push, so needs_input would reach nobody. " +
    "Set alert.requireOutOfBandChannel to false only if that is deliberate.",
  );
}
