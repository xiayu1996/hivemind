import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractCheckFailures } from "./check-failures.js";

const liveOutput = (name: string) =>
  readFileSync(new URL(`../../fixtures/check-output/${name}`, import.meta.url), "utf8");

describe("extractCheckFailures", () => {
  it("names the failing test in the output that bounced S-AGENTRULES-01 twice", () => {
    // Both rounds were byte-identical because the checks ran on a tree that did
    // not contain the Story; what the card needed to be told was this one name,
    // and it sat past the 800 bytes CODE was handed.
    for (const round of ["vitest-merge-1.txt", "vitest-merge-2.txt"]) {
      expect(extractCheckFailures("test", liveOutput(round))).toEqual([
        "src/runner/catalog-snapshot.test.ts > recorded catalogues match the pinned pi > deepseek",
      ]);
    }
  });

  it("reads a node:test TAP summary", () => {
    expect(extractCheckFailures("test", "ok 1 - adds\nnot ok 2 - subtracts\nnot ok 3 - divides\n"))
      .toEqual(["subtracts", "divides"]);
  });

  it("reads a jest summary", () => {
    expect(extractCheckFailures("test", "  \u25cf Coupon \u203a applies the discount\n    expect(received)"))
      .toEqual(["Coupon \u203a applies the discount"]);
  });

  it("reads type errors", () => {
    expect(extractCheckFailures("typecheck", "src/a.ts(12,3): error TS2339: Property 'x' does not exist\n"))
      .toEqual(["src/a.ts:12 TS2339"]);
  });

  it("falls back to the check's own name when it recognises nothing", () => {
    expect(extractCheckFailures("lint", "something went wrong")).toEqual(["lint"]);
  });
});
