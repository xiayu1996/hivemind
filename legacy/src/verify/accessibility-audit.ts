/**
 * The accessibility half of the contract layer (design 08 section 6).
 *
 * It belongs beside the token check for the same reason: both ask a finite,
 * enumerable question about a rendered page, so the failing set shrinks or
 * repeats and the convergence rule can fire. "Is this accessible" in general
 * is not that question -- axe-core's rules are, which is why only what its
 * rules say is judged here and nothing is inferred beyond them.
 *
 * Only `serious` and `critical` refuse. The lower two impacts are advice on a
 * prototype whose copy is still placeholder, and a criterion that refuses on
 * advice spends a card's budget on it.
 */

/** Impacts that refuse. axe-core also reports `minor` and `moderate`. */
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

export interface AccessibilityViolation {
  /** The axe-core rule, e.g. `color-contrast`. */
  id: string;
  impact: string;
  /** The rule's own one-line description. */
  help: string;
  /** A few of the elements it fired on, as selectors. */
  nodes: string[];
}

/**
 * The expression evaluated in the page, after axe's own source has been added
 * to it. Written as a call rather than a function for the reason
 * `collectStylesExpression` gives: a string is evaluated, not called.
 *
 * `resultTypes` keeps axe from assembling the passes and incomplete sets,
 * which on a full page is most of its work and none of its answer here.
 */
export function axeRunExpression(maxNodes = 3): string {
  return `axe.run(document, { resultTypes: ["violations"] }).then((result) => result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact || "unknown",
    help: violation.help,
    nodes: violation.nodes.slice(0, ${maxNodes}).map((node) => node.target.join(" "))
  })))`;
}

/** The violations that refuse, in a stable order. */
export function blockingViolations(
  violations: readonly AccessibilityViolation[],
): AccessibilityViolation[] {
  return violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact))
    .toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** What a person, or the session that drew the page, reads about it. */
export function describeAccessibilityViolations(
  page: string,
  violations: readonly AccessibilityViolation[],
): string[] {
  return blockingViolations(violations).map((violation) =>
    `${page} 上有一处用不了的地方（${violation.id}）：${violation.help}；出现在 ${violation.nodes.join("、")}`
  );
}
