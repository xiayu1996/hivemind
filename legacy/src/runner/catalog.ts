import { snapshotCatalog } from "./catalog-snapshot.js";
import { cachingCatalog, firstNonEmptyCatalog, PiModelCatalog, type ModelCatalog } from "./model-resolver.js";

/**
 * The catalogue every entry point should build. The pinned pi answers where it
 * can, and the recorded snapshot answers for a provider this host has no
 * credentials for — a host onboarding a provider still validates its
 * configuration, and pi is spawned once per provider rather than once per card.
 */
export function defaultModelCatalog(binary: string, cwd?: string): ModelCatalog {
  return firstNonEmptyCatalog(
    cachingCatalog(new PiModelCatalog({ binary, ...(cwd ? { cwd } : {}) })),
    snapshotCatalog(),
  );
}
