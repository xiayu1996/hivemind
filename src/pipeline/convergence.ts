export type ConvergenceClassification =
  | "no_rounds"
  | "baseline"
  | "complete"
  | "converging"
  | "stalled"
  | "expanded"
  | "oscillating"
  /** Never returned by the classifier: the loop was still producing new failure
   * sets when it ran out of rounds. It is named here so a stop point can say
   * which situation ended the loop, all under the stop reasons the database
   * accepts. */
  | "budget_exhausted";

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

export interface ConvergenceOptions {
  /**
   * How many earlier rounds an identical failure set is looked for in before
   * the loop is called oscillating. One means only the round immediately
   * before, which is the stagnation case; larger windows also catch a loop
   * that returns to a set it left.
   */
  oscillationLookback?: number;
}

const DEFAULT_OSCILLATION_LOOKBACK = 3;

/**
 * The inner loop continues unless this round's failure set repeats one it has
 * already produced.
 *
 * The bar used to be the strict proper subset failed(N) ⊂ failed(N-1), which
 * stopped a round that fixed three scenarios and broke a fourth. Real work
 * trades one failure for another and still finishes, so a set that merely
 * changed now buys a round out of the budget instead of ending the card; the
 * round ceiling is what bounds the spend. Repetition is still fatal: a set
 * identical to one already seen means the next round would replay a round
 * that has been run.
 */
export function classifyConvergence(
  history: readonly (readonly string[])[],
  options: ConvergenceOptions = {},
): ConvergenceResult {
  const lookback = options.oscillationLookback ?? DEFAULT_OSCILLATION_LOOKBACK;
  if (history.length === 0) return { classification: "no_rounds", mayContinue: false };
  const rounds = history.map(canonical);
  const current = rounds.at(-1)!;
  if (current.length === 0) return { classification: "complete", mayContinue: false };
  if (rounds.length === 1) return { classification: "baseline", mayContinue: true };

  const previous = rounds.at(-2)!;
  if (same(current, previous)) return { classification: "stalled", mayContinue: false };
  if (rounds.slice(Math.max(0, rounds.length - 1 - lookback), -1).some((earlier) => same(current, earlier))) {
    return { classification: "oscillating", mayContinue: false };
  }
  if (properSubset(current, previous)) return { classification: "converging", mayContinue: true };
  return { classification: "expanded", mayContinue: true };
}

/**
 * What a person reads on a card the verification loop stopped.
 *
 * The situations end the same way and are not the same problem: a loop that
 * went in circles from round two needs a different decision from one that was
 * still making progress when the budget ran out, and reading "verification
 * loop exceeded" alone tells nobody which happened.
 */
export function renderConvergenceReport(
  cardId: string,
  classification: ConvergenceClassification,
  history: readonly (readonly string[])[],
): string {
  const rounds = history.filter((round) => round.length > 0);
  const latest = rounds.at(-1) ?? [];
  const headline: Record<string, string> = {
    stalled: "the same checks failed two rounds running, so another round would repeat the last one",
    oscillating: "an earlier round failed on exactly these checks, so the work is going in circles",
    budget_exhausted: "the failing set was still moving when the card ran out of rounds",
  };
  const lines = [
    `${cardId} stopped: ${headline[classification] ?? "the verification loop ended without an accepted result"}`,
    "",
    `Still failing: ${latest.length > 0 ? latest.join(", ") : "nothing was recorded for the last round"}`,
  ];
  if (rounds.length > 1) {
    lines.push("", "Round by round:");
    for (const [index, round] of rounds.entries()) {
      lines.push(`  ${index + 1}: ${round.join(", ")}`);
    }
  }
  lines.push(
    "",
    classification === "budget_exhausted"
      ? "The card ran out of rounds while the set was still moving. Resuming grants a new budget; raise retry.maxInnerLoopRounds if this keeps happening."
      : "More rounds of the same will not help. Decide what changes: the approach, the tests, or the acceptance bar itself.",
    "",
  );
  return lines.join("\n");
}
