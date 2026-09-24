import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ModelCatalog, ModelDescriptor } from "./model-resolver.js";

const descriptor = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
  thinking: z.boolean().optional(),
  images: z.boolean().optional(),
});

const snapshot = z.object({
  provider: z.string().min(1),
  piVersion: z.string().min(1),
  capturedAt: z.string().min(1),
  models: z.array(descriptor).min(1),
});

export type CatalogSnapshot = z.infer<typeof snapshot>;

/**
 * Recorded `pi --list-models` output, one file per provider, checked into the
 * repository. It exists because the live catalogue answers only on a host that
 * has pi installed *and* that provider's credentials configured, which leaves
 * CI, a reviewer's checkout, and any host onboarding a provider it has no key
 * for yet unable to validate configuration at all.
 *
 * It is captured, never hand-written: `scripts/catalog-snapshot.ts` writes it
 * and `catalog-snapshot.test.ts` fails when it drifts from a live pi.
 */
export function snapshotDirectory(): string {
  return fileURLToPath(new URL("../../fixtures/model-catalogs/", import.meta.url));
}

function snapshotPath(provider: string): string {
  return join(snapshotDirectory(), `${provider}.json`);
}

export function readSnapshot(provider: string): CatalogSnapshot | undefined {
  let raw: string;
  try {
    raw = readFileSync(snapshotPath(provider), "utf8");
  } catch {
    // No snapshot for this provider yet. Absence is a normal state during
    // onboarding, and every caller treats it as "the catalogue says nothing".
    return undefined;
  }
  return snapshot.parse(JSON.parse(raw) as unknown);
}

export function snapshottedProviders(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(snapshotDirectory());
  } catch {
    // The directory is created by the first capture; before that there are none.
    return [];
  }
  return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).toSorted();
}

/**
 * The synchronous answer to "does this provider advertise this model id".
 * Configuration validation runs inside a zod schema, which cannot await a pi
 * spawn, so a bad id would otherwise only be caught at spawn time, on a card,
 * by which point a person has already left the console believing it was saved.
 */
export function snapshotModelIds(provider: string): string[] {
  return (readSnapshot(provider)?.models ?? []).map((model) => model.id).toSorted();
}

export function snapshotCatalog(): ModelCatalog {
  return { list: async (provider) => (readSnapshot(provider)?.models ?? []) as ModelDescriptor[] };
}

export async function writeSnapshot(value: CatalogSnapshot): Promise<string> {
  const parsed = snapshot.parse(value);
  await mkdir(snapshotDirectory(), { recursive: true });
  const path = snapshotPath(parsed.provider);
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path;
}
