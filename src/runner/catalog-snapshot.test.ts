import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readSnapshot,
  snapshotCatalog,
  snapshotModelIds,
  snapshottedProviders,
} from "./catalog-snapshot.js";
import { declaredModelIds } from "./declared-models.js";
import { defaultPiBinary, pinnedPiVersion } from "./pi-binary.js";
import { PiModelCatalog } from "./model-resolver.js";
import { resolveModel } from "./model-resolver.js";

const providers = snapshottedProviders();
const piInstalled = existsSync(defaultPiBinary());

describe("recorded provider catalogues", () => {
  it("has at least one provider recorded", () => {
    expect(providers.length).toBeGreaterThan(0);
  });

  it.each(providers)("%s: every recorded model belongs to its own file", (provider) => {
    const recorded = readSnapshot(provider)!;
    for (const model of recorded.models) expect(model.provider).toBe(provider);
  });

  it.each(providers)("%s: answers the synchronous id lookup configuration validates against", async (provider) => {
    const ids = snapshotModelIds(provider);
    expect(ids.length).toBeGreaterThan(0);
    await expect(resolveModel(snapshotCatalog(), provider, ids[0]!)).resolves.toMatchObject({ provider });
  });
});

describe("models hivemind declares to pi", () => {
  it.each([...declaredModelIds()])("%s: every declared model is in the recorded catalogue", (provider, ids) => {
    // A declared id missing from the recording means the capture ran on a host
    // that had not installed deploy/pi/models.json, and configuration would
    // then refuse an id pi actually serves.
    expect(snapshotModelIds(provider)).toEqual(expect.arrayContaining(ids));
  });
});

/**
 * Drift, not correctness: the recorded catalogue is the authority on hosts that
 * cannot ask pi, so it has to keep matching the pinned build. It is skipped
 * rather than failed where pi is absent or the provider has no credentials,
 * because that is precisely the situation the snapshot exists to serve.
 */
describe.skipIf(!piInstalled)("recorded catalogues match the pinned pi", () => {
  const catalog = new PiModelCatalog({ binary: defaultPiBinary() });

  it.each(providers)("%s", async (provider) => {
    const recorded = readSnapshot(provider)!;
    const live = await catalog.list(provider);
    if (live.length === 0) return; // no credentials for this provider on this host
    expect(recorded.piVersion).toBe(pinnedPiVersion());
    expect(live.toSorted((left, right) => left.id.localeCompare(right.id)))
      .toEqual(recorded.models);
    // Each provider costs one real pi spawn, which can queue behind another
    // process holding pi's credential lock; the default 5s is not enough.
  }, 60_000);
});
