import type { ConfigStore } from "../config/store.js";

/** pi reads this to decide how long a provider should keep a cached prefix. */
export const CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";

/**
 * The prefix cache's time to live, as an environment variable for one pi spawn.
 *
 * pi defaults to the short window, and the gap between two phases of one card
 * is routinely tens of minutes: with the short window the cache is cold again
 * by the time the next phase asks for it, however well its key and its prefix
 * were arranged.
 *
 * It is not a lever everywhere. Only the adapters that put a retention field in
 * the request body honour it -- the OpenAI Responses path (`prompt_cache_*`)
 * and the Anthropic path (`cache_control.ttl`). The ChatGPT subscription path
 * sends no such field at all, so on that provider this only decides whether
 * caching is on, and the real window is whatever the backend gives us.
 */
export function cacheRetentionEnv(config: ConfigStore): Record<string, string> {
  return { [CACHE_RETENTION_ENV]: config.get("cache.retention") };
}
