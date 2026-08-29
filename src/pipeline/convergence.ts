export type ConvergenceClassification =
  | "no_rounds"
  | "baseline"
  | "complete"
  | "converging"
  | "stalled"
  | "expanded"
  | "oscillating";

export interface ConvergenceResult {
  classification: ConvergenceClassification;
  mayContinue: boolean;
}

function canonical(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function properSubset(candidate: readonly string[], previous: readonly string[]): boolean {
  if (candidate.length >= previous.length) return false;
  const previousSet = new Set(previous);
  return candidate.every((value) => previousSet.has(value));
}

/** The inner loop continues only when failed(N) is a strict proper subset. */
export function classifyConvergence(history: readonly (readonly string[])[]): ConvergenceResult {
  if (history.length === 0) return { classification: "no_rounds", mayContinue: false };
  const rounds = history.map(canonical);
  const current = rounds.at(-1)!;
  if (current.length === 0) return { classification: "complete", mayContinue: false };
  if (rounds.length === 1) return { classification: "baseline", mayContinue: true };

  const previous = rounds.at(-2)!;
  if (same(current, previous)) return { classification: "stalled", mayContinue: false };
  if (rounds.slice(0, -1).some((earlier) => same(current, earlier))) {
    return { classification: "oscillating", mayContinue: false };
  }
  if (properSubset(current, previous)) return { classification: "converging", mayContinue: true };
  return { classification: "expanded", mayContinue: false };
}
