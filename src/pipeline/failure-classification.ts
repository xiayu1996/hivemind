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
/** Wording of the verdict check that refuses a screen scenario nobody looked at. */
export const SCREEN_EVIDENCE_MISSING = "no screen evidence of its own was left for this scenario";

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
  // The reviewer landed on a server that is not the worktree's: a route the
  // Story adds is "not found", or the page is the one from before the Story.
  // Nothing about the Story was observed (S-E3OVERVIEW-01 round 2).
  /route\s+(?:GET|POST|PUT|PATCH|DELETE)?:?\s*\S*\s*not found/i,
  /\b(?:pre-existing|previous|old|stale)\b[^.]{0,30}\b(?:view|page|build|ui)\b|could not be reproduced|cannot be reproduced|not the worktree/i,
  // The verifier did not leave its own screen evidence for a scenario: that
  // is the verifier's omission, not the code's failure (03 section 9.3).
  new RegExp(SCREEN_EVIDENCE_MISSING, "i"),
  /browser (?:failed to launch|could not be launched|crashed)|chromium.*(?:not found|failed to launch)/i,
  /playwright.*(?:not installed|missing)/i,
  /no such file or directory.*(?:node_modules|\.cache)/i,
];

/**
 * A phase that died on the provider (credentials, quota, the wire) was not
 * refused for what it built. Feeding that text to the next round as "the
 * rejected approach" asks CODE to fix something it cannot touch.
 */
const PROVIDER_FAULT = [
  /oauth|refresh token|token refresh|sign(?:ing)? in again|invalid_grant|unauthori[sz]ed/i,
  /usage limit|rate limit|too many requests|quota|insufficient balance|\b(?:401|402|429)\b/i,
  /ECONNRESET|ETIMEDOUT|socket hang up|stream (?:ended|closed) unexpectedly|provider request was not captured/i,
  // An operator stopping or resetting the card is not the phase being refused either.
  /stopped by the operator|relaunched|reset to DESIGN/i,
];

export function isProviderFault(reason: string): boolean {
  return PROVIDER_FAULT.some((pattern) => pattern.test(reason));
}

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
