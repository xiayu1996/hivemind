import { createHash } from "node:crypto";

export type RegressionOutcome = "passed" | "failed";

export interface RegressionObservation {
  outcome: RegressionOutcome;
  failureSignature?: string | null;
}

export interface RegressionPolicy {
  /** How many recent runs of one scenario the judgement looks at. */
  windowSize: number;
  /** Failures below this share of the window are flakiness, not a break. */
  failureRateThreshold: number;
  /** A break needs this many failures however small the window is. */
  minFailures: number;
}

export type RegressionJudgement =
  | { kind: "stable" }
  | { kind: "suspect"; failures: number; rate: number }
  | { kind: "raise"; failures: number; rate: number; signature: string };

// Anything that identifies a particular run rather than a particular break:
// absolute paths, line and column numbers, hex ids, durations, timestamps.
const NOISE: Array<[RegExp, string]> = [
  [/(?:[A-Za-z]:)?[\\/][\w.\-\\/]+?([\w.-]+\.[a-z]{1,4})/g, "$1"],
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/\b[0-9a-f]{7,}\b/gi, "<hash>"],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<time>"],
  [/\b\d+(?:\.\d+)?\s?(?:ms|s|seconds?|minutes?)\b/gi, "<duration>"],
  [/:\d+(?::\d+)?\b/g, ":<line>"],
  [/\b\d+\b/g, "<n>"],
];

/**
 * A stable name for one break. Two runs of the same defect produce the same
 * signature even though their output differs in paths, line numbers and
 * timings, which is what lets a repeated failure reuse its card instead of
 * opening a new one every sweep.
 */
export function failureSignature(output: string): string {
  return createHash("sha256").update(normalizeFailureText(output)).digest("hex").slice(0, 32);
}

/**
 * The readable half of a signature: the same text the hash is taken over, with
 * everything that identifies a particular run replaced by a placeholder. Kept
 * separate so a reader can be shown what was grouped and why, rather than a
 * hash they have to take on faith.
 */
export function normalizeFailureText(output: string): string {
  let normalized = output.trim().toLowerCase();
  for (const [pattern, replacement] of NOISE) normalized = normalized.replaceAll(pattern, replacement);
  return normalized.replaceAll(/\s+/g, " ").trim();
}

/**
 * Judges a scenario from a window of observations rather than from the run in
 * front of us. One failure is never enough: a scenario that fails a third of
 * the time is flaky, and raising a card for it buries the breaks that matter.
 */
export function judgeRegression(
  observations: readonly RegressionObservation[],
  policy: RegressionPolicy,
): RegressionJudgement {
  const window = observations.slice(0, policy.windowSize);
  const failures = window.filter((observation) => observation.outcome === "failed");
  if (failures.length === 0) return { kind: "stable" };
  const rate = failures.length / window.length;

  // A card names a break that is happening now: it blocks its Epic from
  // landing and reopens a Story to reproduce it. With the newest run green
  // there is nothing to reproduce, and history alone would raise one anyway --
  // three sweeps of a Story whose code was not yet on the branch stayed in the
  // window and would have opened a card on the first run that passed.
  const newest = window[0];
  if (!newest || newest.outcome !== "failed") {
    return { kind: "suspect", failures: failures.length, rate };
  }

  const bySignature = new Map<string, number>();
  for (const failure of failures) {
    const signature = failure.failureSignature ?? "";
    if (signature) bySignature.set(signature, (bySignature.get(signature) ?? 0) + 1);
  }
  // The card names the break in front of us, so that break has to be the one
  // recurring. A different signature that happens to dominate the window
  // describes something else, and the Story would be reopened to fix it.
  const signature = newest.failureSignature ?? "";
  const recurrences = signature === "" ? 0 : bySignature.get(signature) ?? 0;

  // Nothing in the window passed, so the flaky-or-broken question the
  // signatures exist to answer has already answered itself, and they need not
  // agree. They routinely do not: a screen's failure is a sentence somebody
  // wrote about what they saw, new wording every round, so a scenario that has
  // never once worked would never accumulate a card -- and an Epic would wait
  // at its review gate forever for a break with no owner.
  const neverGreen = failures.length === window.length;

  const raise = failures.length >= policy.minFailures
    && rate >= policy.failureRateThreshold
    && (neverGreen || recurrences >= policy.minFailures);

  return raise
    ? { kind: "raise", failures: failures.length, rate, signature }
    : { kind: "suspect", failures: failures.length, rate };
}
