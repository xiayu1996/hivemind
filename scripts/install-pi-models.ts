/**
 * Renders the provider declarations pi needs and puts them where it reads them.
 *
 *   npx tsx scripts/install-pi-models.ts [--db <url>]
 *
 * The declarations live in `model.providers`, so this is a read of the central
 * configuration rather than a copy of a file in this repository: a host that
 * runs it after a provider was added in the console gets that provider, and a
 * host with no database falls back to the code defaults, which is what a first
 * install has before the database exists.
 *
 * Every pi spawn re-renders the same file through `ModelPolicy`, so this script
 * exists for the install path and for looking at what a host would write; it is
 * not what keeps a running host correct.
 */
import { createClient } from "@libsql/client";
import { ConfigStore } from "../src/config/store.js";
import {
  installPiModelDeclarations,
  piModelDeclarationsPath,
  renderPiModelDeclarations,
} from "../src/runner/pi-model-declarations.js";
import type { ProviderProfile } from "../src/runner/model-policy.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const url = flag("db") ?? process.env.HIVEMIND_DB_URL;
  let store: ConfigStore;
  if (url === undefined) {
    console.log("no database configured; writing the declarations the code defaults carry");
    store = ConfigStore.defaults();
  } else {
    store = await ConfigStore.load(createClient({ url }));
  }
  const profiles = store.get("model.providers") as Record<string, ProviderProfile>;
  const path = piModelDeclarationsPath(process.env.PI_CODING_AGENT_HOME ?? undefined);
  const result = await installPiModelDeclarations(renderPiModelDeclarations(profiles), path);
  const declared = Object.entries(profiles)
    .filter(([, profile]) => profile.declaration !== undefined)
    .map(([provider]) => provider)
    .toSorted();
  console.log(`${result === "written" ? "installed" : "unchanged"} at ${path}: ${declared.join(", ") || "no providers to declare"}`);
}

await main();
