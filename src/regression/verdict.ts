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
  let normalized = output.trim().toLowerCase();
  for (const [pattern, replacement] of NOISE) normalized = normalized.replaceAll(pattern, replacement);
  normalized = normalized.replaceAll(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
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

  const bySignature = new Map<string, number>();
  for (const failure of failures) {
    const signature = failure.failureSignature ?? "";
    if (signature) bySignature.set(signature, (bySignature.get(signature) ?? 0) + 1);
  }
  const dominant = [...bySignature.entries()].toSorted((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0]))[0];

  // The card names one break, so the same break has to be the one recurring.
  const raise = failures.length >= policy.minFailures
    && rate >= policy.failureRateThreshold
    && dominant !== undefined
    && dominant[1] >= policy.minFailures;

  return raise
    ? { kind: "raise", failures: failures.length, rate, signature: dominant[0] }
    : { kind: "suspect", failures: failures.length, rate };
}
