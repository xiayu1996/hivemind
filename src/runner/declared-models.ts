import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const declaration = z.object({
  providers: z.record(z.string(), z.object({
    models: z.array(z.object({ id: z.string().min(1) })).optional(),
  }).passthrough()),
});

/**
 * The models hivemind adds to pi's built-in catalogue, as
 * `deploy/pi/models.json` declares them and `scripts/install-pi-models.sh`
 * installs them into `~/.pi/agent/models.json`.
 *
 * They are read here so a test can hold the declaration and the recorded
 * catalogue to each other: a model declared but never recorded means the
 * fixtures were captured on a host that had not installed the declaration, and
 * every configuration check would then refuse an id that is in fact available.
 */
export function declaredModelIds(): Map<string, string[]> {
  const path = fileURLToPath(new URL("../../deploy/pi/models.json", import.meta.url));
  const parsed = declaration.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  const byProvider = new Map<string, string[]>();
  for (const [provider, profile] of Object.entries(parsed.providers)) {
    const ids = (profile.models ?? []).map((model) => model.id).toSorted();
    if (ids.length > 0) byProvider.set(provider, ids);
  }
  return byProvider;
}
