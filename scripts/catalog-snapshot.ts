import { defaultSecretsPath, loadSecretsFile } from "../src/config/secrets-file.js";
import { writeSnapshot } from "../src/runner/catalog-snapshot.js";
import { defaultPiBinary, pinnedPiVersion } from "../src/runner/pi-binary.js";
import { PiModelCatalog } from "../src/runner/model-resolver.js";
import { MissingProviderKeyError, defaultApiKeyEnvVar, providerKeyEnv } from "../src/runner/provider-env.js";

/**
 * Records what the pinned pi reports for a provider into
 * `fixtures/model-catalogs/`, so hosts without pi or without that provider's
 * credentials can still validate configuration.
 *
 *   npx tsx scripts/catalog-snapshot.ts <provider> [...more providers]
 *   npx tsx scripts/catalog-snapshot.ts zai --env-key ZAI_TOKEN
 *
 * An API-key provider's key is read from `~/.hivemind/secrets.env`, the same
 * file systemd hands the daemons: nothing exports it into a shell, and pi lists
 * an empty table rather than an error when it is missing. `--env-key` names the
 * variable for a provider pi does not name `<PROVIDER>_API_KEY`. An OAuth
 * provider needs none of this, so a missing key is reported, not fatal.
 */
function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const providers = process.argv.slice(2).filter((argument, index, all) =>
  !argument.startsWith("--") && all[index - 1] !== "--env-key");
if (providers.length === 0) {
  console.error("usage: npx tsx scripts/catalog-snapshot.ts <provider> [...] [--env-key VAR]");
  process.exit(2);
}

const secretsPath = defaultSecretsPath();
const secrets = await loadSecretsFile(secretsPath).catch(() => new Map<string, string>());
const capturedAt = new Date().toISOString();

for (const provider of providers) {
  const envKey = optional("--env-key");
  let env: Record<string, string> = {};
  try {
    env = providerKeyEnv({ provider, ...(envKey ? { envKey } : {}), secrets, secretsPath });
  } catch (cause) {
    // An OAuth provider legitimately has no key here, and pi answers anyway, so
    // the listing is still attempted and only the empty result is fatal.
    if (!(cause instanceof MissingProviderKeyError)) throw cause;
  }

  const models = await new PiModelCatalog({ binary: defaultPiBinary(), env }).list(provider);
  if (models.length === 0) {
    const variable = envKey ?? defaultApiKeyEnvVar(provider);
    console.error(`${provider}: pi listed no models. For an API-key provider, set ${variable} in ${secretsPath}` +
      ` (or pass --env-key if pi names it differently); for an OAuth provider, run scripts/pi-login.sh.`);
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
