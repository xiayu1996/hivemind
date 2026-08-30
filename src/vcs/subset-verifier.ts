import type { BlindVerifyInput, BlindVerifyResult } from "../verify/executor.js";
import type { SubsetVerifier } from "./merge-flow.js";

export interface SubsetVerifyPort {
  run(input: BlindVerifyInput): Promise<BlindVerifyResult>;
}

/**
 * Re-verifies a scenario subset on the integration branch through the same
 * blind verifier a Story uses, so the commands are still chosen by an agent
 * looking at the tree rather than baked in here.
 *
 * The set it returns is the set the verdict actually covered, which is what the
 * merge flow compares against what it asked for: echoing the request back would
 * make that check prove nothing.
 */
export function blindSubsetVerifier(
  port: SubsetVerifyPort,
  base: Omit<BlindVerifyInput, "declaredScenarioIds">,
): SubsetVerifier {
  return async (scenarioIds) => {
    const declaredScenarioIds = [...scenarioIds];
    const result = await port.run({ ...base, declaredScenarioIds });
    const passed = result.record.verdict === "accepted";
    return {
      passed,
      scenarioIds: passed ? declaredScenarioIds : result.record.failedScenarios,
    };
  };
}
