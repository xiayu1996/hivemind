import { writeSnapshot } from "../src/runner/catalog-snapshot.js";
import { defaultPiBinary, pinnedPiVersion } from "../src/runner/pi-binary.js";
import { PiModelCatalog } from "../src/runner/model-resolver.js";

/**
 * Records what the pinned pi reports for a provider into
 * `fixtures/model-catalogs/`, so hosts without pi or without that provider's
 * credentials can still validate configuration. Run it on a host where the
 * provider's key is present: pi lists nothing for an unauthenticated provider.
 *
 *   npx tsx scripts/catalog-snapshot.ts <provider> [...more providers]
 */
const providers = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (providers.length === 0) {
  console.error("usage: npx tsx scripts/catalog-snapshot.ts <provider> [...]");
  process.exit(2);
}

const catalog = new PiModelCatalog({ binary: defaultPiBinary() });
const capturedAt = new Date().toISOString();

for (const provider of providers) {
  const models = await catalog.list(provider);
  if (models.length === 0) {
    console.error(`${provider}: pi listed no models; configure this provider's credentials on this host first`);
    process.exitCode = 1;
    continue;
  }
  const path = await writeSnapshot({
    provider,
    piVersion: pinnedPiVersion(),
    capturedAt,
    models: models.toSorted((left, right) => left.id.localeCompare(right.id)),
  });
  console.log(`${provider}: ${models.length} models -> ${path}`);
}
