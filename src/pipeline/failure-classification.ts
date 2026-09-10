/**
 * Whether a rejected scenario says something about the code or about the box it
 * ran on.
 *
 * The convergence criterion compares the failing set between rounds, so it is
 * only meaningful if that set describes the code. A round the verifier lost to
 * a dev server that never came up, a port somebody else was holding or a
 * screenshot written outside the evidence root tells us nothing about whether
 * the Story is converging, and counting it spends a round of a budget that a
 * person then has to top up by hand.
 */
const ENVIRONMENT_REASON = [
  /ECONNREFUSED|ECONNRESET|EADDRINUSE|EHOSTUNREACH|ENOTFOUND/i,
  /connection refused|connection reset|could not connect|unable to connect/i,
  /address already in use|port \d+ is (?:already )?in use/i,
  /(?:service|server|dev server|app|site|page)\b[^.]{0,40}?\bnot (?:running|reachable|up|started|available|serving)/i,
  /\bnot (?:running|started|up)\b[^.]{0,20}\b(?:service|server|app)\b/i,
  // Every 5xx, not only the gateway family. The reviewer stands its own
  // harness up to look at a screen, so a 500 it meets is as likely to come
  // from that scaffolding as from the Story: S-E3OVERVIEW-01 was parked by a
  // 500 raised inside the stub the reviewer itself had written. A real defect
  // in the code still fails a test, which is the lane that judges code.
  /\b(?:502|503|504)\b/,
  /\bhttp\s*5\d{2}\b/i,
  /\b(?:status|status code|code)\s*[:=]?\s*5\d{2}\b/i,
  /\b5\d{2}\b[^.]{0,30}(?:internal server error|server error)|internal server error/i,
  /screenshot (?:does not exist|is not a file|escapes the evidence root)/i,
  /browser (?:failed to launch|could not be launched|crashed)|chromium.*(?:not found|failed to launch)/i,
  /playwright.*(?:not installed|missing)/i,
  /no such file or directory.*(?:node_modules|\.cache)/i,
];

export function isEnvironmentFailure(reason: string): boolean {
  return ENVIRONMENT_REASON.some((pattern) => pattern.test(reason));
}

export interface ScenarioReason {
  scenarioId: string;
  reason: string;
}

/**
 * Splits a round's failures. A scenario with any code-level reason counts as
 * code-level: the environment being unhappy does not excuse a real failure
 * reported beside it.
 */
export function splitScenarioFailures(
  failedScenarios: readonly string[],
  reasons: readonly ScenarioReason[],
): { code: string[]; environment: string[] } {
  const code: string[] = [];
  const environment: string[] = [];
  for (const scenarioId of failedScenarios) {
    const own = reasons.filter((entry) => entry.scenarioId === scenarioId);
    // No reason at all is not evidence of a healthy environment.
    const environmental = own.length > 0 && own.every((entry) => isEnvironmentFailure(entry.reason));
    (environmental ? environment : code).push(scenarioId);
  }
  return { code, environment };
}
