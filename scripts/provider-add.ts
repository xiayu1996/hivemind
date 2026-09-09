import { readSnapshot } from "../src/runner/catalog-snapshot.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { ConfigStore } from "../src/config/store.js";
import type { ProviderProfile } from "../src/runner/model-policy.js";

/**
 * Declares a provider in `model.providers`, the same key the console edits.
 * It writes through ConfigStore so the registry schema is the only validator:
 * a script with its own idea of a valid profile would be a second, weaker one.
 *
 *   npx tsx scripts/catalog-snapshot.ts deepseek       # record the catalogue first
 *   npx tsx scripts/provider-add.ts deepseek --auth-type api_key \
 *     --env-key DEEPSEEK_API_KEY \
 *     --brain deepseek-v4-pro --standard deepseek-v4-pro --cheap deepseek-v4-flash
 *
 * Adding the provider to `model.failoverChain` stays a separate, deliberate
 * step: declaring how a provider would be used is not the same decision as
 * putting live cards on it.
 */
function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const provider = process.argv[2];
if (!provider || provider.startsWith("--")) {
  console.error("usage: npx tsx scripts/provider-add.ts <provider> --auth-type <api_key|oauth> [--env-key KEY] [--brain id] [--standard id] [--cheap id]");
  process.exit(2);
}

const snapshot = readSnapshot(provider);
if (!snapshot) {
  console.error(`no recorded catalogue for ${provider}; run: npx tsx scripts/catalog-snapshot.ts ${provider}`);
  process.exit(1);
}

const tiers = {
  ...(optional("--brain") ? { brain: optional("--brain")! } : {}),
  ...(optional("--standard") ? { standard: optional("--standard")! } : {}),
  ...(optional("--cheap") ? { cheap: optional("--cheap")! } : {}),
};

if (Object.keys(tiers).length === 0) {
  console.log(`${provider} advertises:`);
  for (const model of snapshot.models) {
    console.log(`  ${model.id}  context=${model.contextWindow ?? "?"} thinking=${model.thinking ?? "?"}`);
  }
  console.log("\nrerun with --brain / --standard / --cheap naming the models to use");
  process.exit(0);
}

const authType = optional("--auth-type");
if (authType !== "api_key" && authType !== "oauth") {
  console.error("--auth-type must be api_key or oauth");
  process.exit(2);
}

const profile: ProviderProfile = {
  authType,
  ...(optional("--env-key") ? { envKey: optional("--env-key")! } : {}),
  tiers,
};

const handle = openDb(process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db");
await migrate(handle.client);
const config = await ConfigStore.load(handle.client);
const current = config.get("model.providers") as Record<string, ProviderProfile>;
try {
  await config.set("model.providers", { ...current, [provider]: profile }, process.env.USER ?? "provider-add");
} catch (cause) {
  console.error((cause as Error).message);
  process.exit(1);
}

console.log(`${provider} declared: ${Object.entries(tiers).map(([tier, id]) => `${tier}=${id}`).join(" ")}`);
console.log(`add it to model.failoverChain when you want cards to run on it; current chain: ${config.get("model.failoverChain").join(", ")}`);
