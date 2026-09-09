import type { ProviderProfile } from "./model-policy.js";

/**
 * The variable pi reads a provider's key from, by pi's own convention
 * (`docs/providers.md`): the provider name upper-cased with separators folded
 * to underscores, suffixed `_API_KEY`. It is only a default — a profile that
 * names its `envKey` wins, because pi does not follow the convention for every
 * provider.
 */
export function defaultApiKeyEnvVar(provider: string): string {
  return `${provider.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_API_KEY`;
}

export class MissingProviderKeyError extends Error {
  constructor(readonly provider: string, readonly envKey: string, secretsPath: string) {
    super(`${provider} needs ${envKey}; it is neither exported nor set in ${secretsPath}`);
    this.name = "MissingProviderKeyError";
  }
}

export interface ProviderKeyInput {
  provider: string;
  /** From the provider profile; falls back to pi's naming convention. */
  envKey?: string;
  secrets: ReadonlyMap<string, string>;
  secretsPath: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The single variable a pi spawn needs for an API-key provider.
 *
 * Keys live in `~/.hivemind/secrets.env`, which systemd hands to the daemons as
 * an `EnvironmentFile`. Nothing hands it to a command a person runs by hand, so
 * a script that spawns pi has to read the file itself — otherwise pi is told
 * nothing, `--list-models` prints an empty table, and the operator is told to
 * configure a credential they already configured.
 *
 * Only that one variable is passed on. Handing pi the whole file would put
 * NOTION_TOKEN and every other unrelated credential into a subprocess that has
 * no business with them.
 */
export function providerKeyEnv(input: ProviderKeyInput): Record<string, string> {
  const envKey = input.envKey ?? defaultApiKeyEnvVar(input.provider);
  const exported = (input.env ?? process.env)[envKey];
  const value = exported ?? input.secrets.get(envKey);
  if (!value) throw new MissingProviderKeyError(input.provider, envKey, input.secretsPath);
  return { [envKey]: value };
}

/** OAuth providers keep their credential in pi's own auth file, not the environment. */
export function needsApiKeyEnv(profile: Pick<ProviderProfile, "authType">): boolean {
  return profile.authType === "api_key";
}
