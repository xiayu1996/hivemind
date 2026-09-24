import { selectProjectChecks, type ProjectCheck } from "../pipeline/code-exit-gate.js";
import { extractCheckFailures } from "./check-failures.js";
import type { MergeFailureAttribution, SubsetVerifier } from "./merge-flow.js";

export interface CheckOutcome {
  passed: boolean;
  /** Tail of the output; it becomes the reason the Story is sent back. */
  detail: string;
  /** Set when the check could not be run at all, as opposed to running and
   * failing. A missing binary or a worktree that is not there says nothing
   * about the code, so it must not be charged to the Story. */
  spawnError?: boolean;
}

export interface IntegrationCheckPort {
  /** Runs one declared check in the given worktree. */
  run(check: ProjectCheck, cwd: string): Promise<CheckOutcome>;
}

/**
 * Re-verifies a merge by running the repository's own declared checks on the
 * rebased Story tree, and, when one fails, on the Epic head without it.
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
 * The second run is what makes the first one actionable. "The checks fail with
 * this Story on top" and "the checks were already failing" lead to opposite
 * decisions - one is the Story's round to spend, the other is the Epic
 * branch's problem - and without the comparison S-AGENTRULES-01 spent two
 * rounds rewriting code against a failure it had never caused.
 *
 * The scenario ids are carried through for the record only. A failing test
 * cannot be attributed to one scenario, so a failure fails the whole subset:
 * merging a branch whose tests do not pass is not a decision worth splitting.
 */
export function testSubsetVerifier(
  port: IntegrationCheckPort,
  checks: readonly ProjectCheck[],
): SubsetVerifier {
  return async (request) => {
    const requested = [...request.scenarioIds];
    if (checks.length === 0) {
      return {
        passed: false,
        scenarioIds: requested,
        reasons: ["the repository declares no check to re-verify a merge with (codeExit.projectChecks is empty)"],
      };
    }
    const reasons: string[] = [];
    const failures: string[] = [];
    const failedChecks: string[] = [];
    const ranChecks: string[] = [];
    let attribution: MergeFailureAttribution | undefined;
    for (const { check, relevant } of selectProjectChecks(checks, request.changedPaths)) {
      if (!relevant) continue;
      ranChecks.push(check.name);
      const outcome = await port.run(check, request.candidate.cwd);
      if (outcome.passed) continue;
      failedChecks.push(check.name);
      if (outcome.spawnError) {
        attribution = worst(attribution, "environment");
        reasons.push(`${check.name} could not be run: ${outcome.detail}`);
        continue;
      }
      const failed = extractCheckFailures(check.name, outcome.detail);
      for (const name of failed) if (!failures.includes(name)) failures.push(name);

      // The same check on the Epic head alone. Only run when the candidate has
      // already failed: a merge that lands cleanly must not pay for a second
      // full suite.
      const baseline = await port.run(check, request.base.cwd);
      const baselineFailures = baseline.passed || baseline.spawnError
        ? []
        : extractCheckFailures(check.name, baseline.detail);
      const alreadyBroken = baselineFailures.some((name) => failed.includes(name));
      attribution = worst(attribution, alreadyBroken ? "baseline_failing" : "story_regression");
      reasons.push(
        alreadyBroken
          ? `${check.name} fails on ${request.base.revision} without this Story: ${failed.join(", ")}`
          : `${check.name} fails with this Story on top of ${request.base.revision}: ${failed.join(", ")}\n${outcome.detail}`,
      );
    }
    if (failedChecks.length === 0) {
      return { passed: true, scenarioIds: requested, ranChecks };
    }
    return {
      passed: false,
      scenarioIds: requested,
      reasons,
      ...(attribution ? { attribution } : {}),
      failures,
      failedChecks,
      ranChecks,
    };
  };
}

/**
 * One merge can fail several checks for different reasons, and the Story is
 * charged for the worst of them: a regression it introduced outranks an
 * environment that would not start, which outranks a head that was already
 * red. Reading it the other way round would let one pre-existing failure
 * excuse a real one.
 */
const SEVERITY: Record<MergeFailureAttribution, number> = {
  story_regression: 3,
  environment: 2,
  baseline_failing: 1,
};

function worst(
  current: MergeFailureAttribution | undefined,
  next: MergeFailureAttribution,
): MergeFailureAttribution {
  return current === undefined || SEVERITY[next] > SEVERITY[current] ? next : current;
}
