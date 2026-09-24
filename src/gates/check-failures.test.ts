import { describe, expect, it } from "vitest";
import { extractCheckFailures } from "./check-failures.ts";

/**
 * The tail of a real merge re-verification, byte for byte (captured on
 * 2026-09-19; the capture starts mid-line because only the tail was kept).
 * The round that received it was sent back twice with 800 bytes of the diff
 * below and never the one name it needed.
 */
const BOUNCED_MERGE_OUTPUT = [
  "nner/activity.test.ts (4 tests) 2ms",
  " \u2713 src/alert/required-channel.test.ts (3 tests) 33ms",
  " \u2713 src/config/secrets-file.test.ts (3 tests) 8ms",
  " \u2713 src/alert/config.test.ts (2 tests) 3ms",
  " \u2713 src/runner/auth-probe.test.ts (1 test) 5ms",
  " \u2713 src/runner/cache-retention.test.ts (1 test) 1ms",
  "",
  " Test Files  1 failed | 161 passed (162)",
  "      Tests  1 failed | 1322 passed (1323)",
  "   Start at  00:43:06",
  "   Duration  9.53s (transform 2.23s, setup 0ms, collect 10.56s, tests 16.31s, environment 17ms, prepare 7.47s)",
  "",
  "stderr | src/vcs/story-delivery.test.ts > GitMrStoryDelivery for a Story that no Epic MR covers > opens nothing for a branch the target branch already contains",
  "Story S-EPIC1-01: epic/EPIC1 already contains story/epic1-01; no review request to open",
  "",
  "fatal: path 'src/coupon.ts' exists on disk, but not in '512aa00d77f7ca382d03261943fd39081dbf7188'",
  "",
  "\u23af\u23af\u23af\u23af\u23af\u23af\u23af Failed Tests 1 \u23af\u23af\u23af\u23af\u23af\u23af\u23af",
  "",
  " FAIL  src/runner/catalog-snapshot.test.ts > recorded catalogues match the pinned pi > deepseek",
  "AssertionError: expected [ Array(5) ] to deeply equal [ Array(4) ]",
  "",
  "\u001b[32m- Expected\u001b[39m",
  "\u001b[31m+ Received\u001b[39m",
  "",
  "\u001b[33m@@ -29,6 +29,14 @@\u001b[39m",
  "\u001b[2m      \"images\": false,\u001b[22m",
  "\u001b[2m      \"maxOutput\": 384000,\u001b[22m",
  "\u001b[2m      \"provider\": \"deepseek\",\u001b[22m",
  "\u001b[2m      \"thinking\": true,\u001b[22m",
  "\u001b[2m    },\u001b[22m",
  "\u001b[31m+   {\u001b[39m",
  "\u001b[31m+     \"contextWindow\": 1000000,\u001b[39m",
  "\u001b[31m+     \"id\": \"deepseek/deepseek-v4.1-flash\",\u001b[39m",
  "\u001b[31m+     \"images\": true,\u001b[39m",
  "\u001b[31m+     \"maxOutput\": 65500,\u001b[39m",
  "\u001b[31m+     \"provider\": \"command-code\",\u001b[39m",
  "\u001b[31m+     \"thinking\": true,\u001b[39m",
  "\u001b[31m+   },\u001b[39m",
  "\u001b[2m  ]\u001b[22m",
  "",
  " \u276f src/runner/catalog-snapshot.test.ts:58:8",
  "     56|     expect(recorded.piVersion).toBe(pinnedPiVersion());",
  "     57|     expect(live.toSorted((left, right) => left.id.localeCompare(right.\u2026",
  "     58|       .toEqual(recorded.models);",
  "       |        ^",
  "     59|     // Each provider costs one real pi spawn, which can queue behind a\u2026",
  "     60|     // process holding pi's credential lock; the default 5s is not eno\u2026",
  "",
  "\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af[1/1]\u23af",
].join("\n");

/**
 * vitest 3.2 on a run where one file failed to load and another failed an
 * assertion, with the lines that print local paths left out. The file that
 * failed to load has no per-file line at all, and the per-file line of the
 * other carries a duration after its counts.
 */
const LOAD_AND_ASSERTION_FAILURES = [
  " \u276f src/cart.test.ts (2 tests | 1 failed) 4ms",
  "   \u00d7 adds 4ms",
  "     \u2192 expected 1 to be 2 // Object.is equality",
  "   \u2713 ok 0ms",
  "",
  "\u23af\u23af\u23af\u23af\u23af\u23af Failed Suites 1 \u23af\u23af\u23af\u23af\u23af\u23af\u23af",
  "",
  " FAIL  src/broken.test.ts [ src/broken.test.ts ]",
  " \u276f src/broken.test.ts:2:1",
  "      1| import { it, expect } from \"vitest\";",
  "      2| import \"./missing-module.ts\";",
  "       | ^",
  "      3| it(\"x\", () => expect(1).toBe(1));",
  "      4| ",
  "",
  "\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af[1/2]\u23af",
  "",
  "\u23af\u23af\u23af\u23af\u23af\u23af\u23af Failed Tests 1 \u23af\u23af\u23af\u23af\u23af\u23af\u23af",
  "",
  " FAIL  src/cart.test.ts > adds",
  "AssertionError: expected 1 to be 2 // Object.is equality",
  "",
  "\u001b[32m- Expected\u001b[39m",
  "\u001b[31m+ Received\u001b[39m",
  "",
  "\u001b[32m- 2\u001b[39m",
  "\u001b[31m+ 1\u001b[39m",
  "",
  " \u276f src/cart.test.ts:2:28",
  "      1| import { it, expect } from \"vitest\";",
  "      2| it(\"adds\", () => expect(1).toBe(2));",
  "       |                            ^",
  "      3| it(\"ok\", () => expect(1).toBe(1));",
  "      4| ",
  "",
  "\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af[2/2]\u23af",
  "",
  " Test Files  2 failed (2)",
  "      Tests  1 failed | 1 passed (2)",
].join("\n");

describe("extractCheckFailures", () => {
  it("names the one failing test in the output that bounced a merge twice", () => {
    expect(extractCheckFailures("test", BOUNCED_MERGE_OUTPUT)).toEqual([
      "src/runner/catalog-snapshot.test.ts > recorded catalogues match the pinned pi > deepseek",
    ]);
  });

  it("reads the whole output, however far past any cut the failure sits", () => {
    const output = `${"passing noise\n".repeat(50_000)} FAIL  src/late.test.ts > found at the end\n`;
    expect(extractCheckFailures("test", output)).toEqual(["src/late.test.ts > found at the end"]);
  });

  it("names a file that failed to load, and each failing test once", () => {
    expect(extractCheckFailures("test", LOAD_AND_ASSERTION_FAILURES)).toEqual([
      "src/broken.test.ts",
      "src/cart.test.ts > adds",
    ]);
  });

  it("reads the vitest per-file summary line when no test of that file is named", () => {
    const output = " \u276f src/cart.test.ts (4 tests | 1 failed) 12ms\n \u2713 src/ok.test.ts (2 tests) 3ms\n";
    expect(extractCheckFailures("test", output)).toEqual(["src/cart.test.ts"]);
  });

  it("reads a node:test TAP summary", () => {
    expect(extractCheckFailures("test", "ok 1 - adds\nnot ok 2 - subtracts\nnot ok 3 - divides\n"))
      .toEqual(["subtracts", "divides"]);
  });

  it("reads the node:test spec reporter, which is what it writes without a terminal", () => {
    const output = [
      "\u2716 the epic head is red (0.71ms)",
      "\u2714 @scenario S-MOCK-02-unit passes on observed evidence (0.65ms)",
      "\u2139 fail 1",
      "\u2716 failing tests:",
      "",
      "test at tests/baseline.test.js:2:1",
      "\u2716 the epic head is red (0.71ms)",
    ].join("\n");
    expect(extractCheckFailures("tests", output)).toEqual(["the epic head is red"]);
  });

  it("reads a jest summary and skips its console blocks", () => {
    const output = "  \u25cf Console\n\n  \u25cf Coupon \u203a applies the discount\n    expect(received)";
    expect(extractCheckFailures("test", output)).toEqual(["Coupon \u203a applies the discount"]);
  });

  it("reads type errors", () => {
    expect(extractCheckFailures("typecheck", "src/a.ts(12,3): error TS2339: Property 'x' does not exist\n"))
      .toEqual(["src/a.ts:12 TS2339"]);
  });

  it("reads a summary line a runner coloured for a terminal", () => {
    expect(extractCheckFailures("test", "\u001b[31m FAIL \u001b[39m src/a.test.ts > adds\n"))
      .toEqual(["src/a.test.ts > adds"]);
  });

  it("falls back to the check's own name when it recognises nothing", () => {
    expect(extractCheckFailures("lint", "something went wrong")).toEqual(["lint"]);
  });
});
