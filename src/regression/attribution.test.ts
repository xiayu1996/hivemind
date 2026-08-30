import { describe, expect, it, vi } from "vitest";
import { attributeRegression } from "./attribution.js";

const SEQUENCE = ["S-M2-01", "S-M2-02", "S-M2-03", "S-M2-04", "S-M2-05"];

/** Fails from the given position onwards, the way a real break behaves. */
function breaksAt(position: number) {
  return vi.fn(async (index: number) => index >= position);
}

describe("attributeRegression", () => {
  it("finds the Story that introduced the break", async () => {
    await expect(attributeRegression(SEQUENCE, breaksAt(3)))
      .resolves.toMatchObject({ kind: "introduced", item: "S-M2-03", index: 2 });
  });

  it("finds a break introduced by the first Story in the sequence", async () => {
    await expect(attributeRegression(SEQUENCE, breaksAt(1)))
      .resolves.toMatchObject({ kind: "introduced", item: "S-M2-01", index: 0 });
  });

  it("finds a break introduced by the last Story in the sequence", async () => {
    await expect(attributeRegression(SEQUENCE, breaksAt(5)))
      .resolves.toMatchObject({ kind: "introduced", item: "S-M2-05", index: 4 });
  });

  it("blames nobody in the sequence for a failure that was already there", async () => {
    await expect(attributeRegression(SEQUENCE, breaksAt(0))).resolves.toMatchObject({ kind: "pre_existing" });
  });

  it("refuses to pin a failure it cannot reproduce at the tip", async () => {
    await expect(attributeRegression(SEQUENCE, async () => false))
      .resolves.toMatchObject({ kind: "not_reproduced" });
  });

  it("spends a logarithmic number of probes, not one per Story", async () => {
    const sequence = Array.from({ length: 64 }, (_, index) => `S-M2-${index}`);
    const probe = breaksAt(40);

    const attribution = await attributeRegression(sequence, probe);

    expect(attribution).toMatchObject({ kind: "introduced", item: "S-M2-39" });
    // Two ends plus log2(64); a linear walk would be 64.
    expect(probe.mock.calls.length).toBeLessThanOrEqual(2 + 6);
  });

  it("handles an empty sequence without pretending to attribute anything", async () => {
    await expect(attributeRegression([], async () => true)).resolves.toMatchObject({ kind: "pre_existing" });
    await expect(attributeRegression([], async () => false)).resolves.toMatchObject({ kind: "not_reproduced" });
  });
});
