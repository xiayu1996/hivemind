import { CONFIG_KEYS } from "../config/registry.js";
import type { ProviderProfile } from "./model-policy.js";

/**
 * The models hivemind adds to pi's built-in catalogue, as `model.providers`
 * declares them by default.
 *
 * Read from the configuration's own defaults rather than from a file, because
 * the declaration is configuration: a host renders it before every spawn, and
 * a console edit changes it without a deploy. The defaults are what a fresh
 * install advertises, which is what the recorded catalogues were captured
 * against -- a test holds the two to each other, because a model declared but
 * never recorded means the snapshot was taken on a host that had not yet
 * rendered the declaration, and every configuration check would then refuse an
 * id that is in fact available.
 */
export function declaredModelIds(): Map<string, string[]> {
  const profiles = CONFIG_KEYS["model.providers"].default as Record<string, ProviderProfile>;
  const byProvider = new Map<string, string[]>();
  for (const [provider, profile] of Object.entries(profiles)) {
    const ids = (profile.declaration?.models ?? []).map((model) => model.id).toSorted();
    if (ids.length > 0) byProvider.set(provider, ids);
  }
  return byProvider;
}
