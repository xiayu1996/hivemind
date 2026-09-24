import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import vitestConfig from "../../vitest.config.js";
import { matchesAnyGlob } from "../pipeline/path-glob.js";

const include = vitestConfig.test?.include ?? [];

/**
 * A file nobody runs proves nothing, and the way this repository loses one is
 * silent: each Story names its test files in whichever shape its model likes,
 * and then widens the include list to match. Two Epics that chose differently
 * conflict on `vitest.config.ts`, and whichever side wins the merge, the other
 * side's tests stop being collected without a single failure to show for it.
 * epic/R237511MB carried three `*_test.ts` files against a main that only knew
 * `test_*.ts` (2026-09-20).
 */
const SHAPES = ["src/example/thing.test.ts", "src/example/test_thing.ts", "src/example/thing_test.ts"];

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else found.push(path);
  }
  return found;
}

describe("vitest collection", () => {
  it("collects a test file whichever shape a Story named it in", () => {
    expect(SHAPES.filter((path) => !matchesAnyGlob(path, include))).toEqual([]);
  });

  it("leaves no file that reads as a test uncollected", async () => {
    const looksLikeTest = /(\.test\.ts|_test\.ts)$|\/test_[^/]*\.ts$/;
    const uncollected = (await filesUnder("src"))
      .filter((path) => looksLikeTest.test(path))
      .filter((path) => !matchesAnyGlob(path, include))
      .toSorted((left, right) => left.localeCompare(right));
    expect(uncollected).toEqual([]);
  });
});
