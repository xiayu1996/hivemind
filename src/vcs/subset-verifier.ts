import type { ProjectCheck } from "../pipeline/code-exit-gate.js";
import type { SubsetVerifier } from "./merge-flow.js";

export interface CheckOutcome {
  passed: boolean;
  /** Tail of the output; it becomes the reason the Story is sent back. */
  detail: string;
}

export interface IntegrationCheckPort {
  /** Runs one declared check in the integration worktree. */
  run(check: ProjectCheck): Promise<CheckOutcome>;
}

/**
 * Re-verifies a merge by running the repository's own declared checks on the
 * integration branch.
 *
 * The subset re-verification exists to catch a Story that is correct alone and
 * wrong once stacked with its siblings, and that is a real failure mode: the
 * Stories of one Epic routinely touch the same pages and routes. It used to be
 * a full blind browser verification, which made every merge a fresh chance for
 * a browser, a dev server or a screenshot path to fail and send a Story that
 * had already been accepted back to CODE. Tests are deterministic, cost close
 * to nothing, and answer the same question; the browser sweep moved to the
 * regression loop, where a failure raises a regression card instead.
 *
 * The scenario ids are carried through for the record only. A failing test
 * cannot be attributed to one scenario, so a failure fails the whole subset:
 * merging a branch whose tests do not pass is not a decision worth splitting.
 */
export function testSubsetVerifier(
  port: IntegrationCheckPort,
  checks: readonly ProjectCheck[],
): SubsetVerifier {
  return async (scenarioIds) => {
    const requested = [...scenarioIds];
    if (checks.length === 0) {
      return {
        passed: false,
        scenarioIds: requested,
        reasons: ["the repository declares no check to re-verify a merge with (codeExit.projectChecks is empty)"],
      };
    }
    const reasons: string[] = [];
    for (const check of checks) {
      const outcome = await port.run(check);
      if (!outcome.passed) reasons.push(`${check.name} failed on the integration branch: ${outcome.detail}`);
    }
    return reasons.length === 0
      ? { passed: true, scenarioIds: requested }
      : { passed: false, scenarioIds: requested, reasons };
  };
}
