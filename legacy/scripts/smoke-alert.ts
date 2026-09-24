import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { alertChannelsFromConfig } from "../src/alert/config.js";
import { AlertRouter } from "../src/alert/index.js";

async function loadSecrets(): Promise<Map<string, string>> {
  const path = join(homedir(), ".hivemind", "secrets.env");
  const content = await readFile(path, "utf8").catch((cause) => {
    throw new Error(`cannot read ${path}: ${(cause as Error).message}`, { cause });
  });
  const values = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("secrets.env contains an invalid assignment");
    const key = line.slice(0, separator).trim();
    let rawValue = line.slice(separator + 1).trim();
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
      rawValue = rawValue.slice(1, -1);
    }
    values.set(key, rawValue);
  }
  return values;
}

async function main(): Promise<void> {
  const secrets = await loadSecrets();
  const channels = alertChannelsFromConfig(secrets);
  if (channels.length === 0) throw new Error("configure FEISHU_WEBHOOK_URL or SMTP settings in ~/.hivemind/secrets.env");

  const result = await new AlertRouter(channels).send({
    kind: "p0",
    title: "hivemind alert smoke",
    body: "The out-of-band alert path is reachable from this host.",
    cardId: "alert-smoke",
  });
  if (result.delivered.length === 0) throw new Error(`all alert channels failed: ${JSON.stringify(result.failed)}`);
  console.log(`PASS: alert delivered through ${result.delivered.join(", ")}`);
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${(error as Error).message}`);
  process.exit(1);
});
