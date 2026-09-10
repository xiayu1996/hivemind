import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyError, type ErrorClass } from "./classify.js";
import { extractFailure } from "./failure.js";
import type { RpcEvent } from "./types.js";

/**
 * The failure wordings each provider was actually observed to emit, one
 * directory per provider, captured from real error streams rather than written
 * by hand.
 *
 * They exist because the classifier reads text, and because a provider's error
 * surface is only known once one of its failures has travelled the whole path:
 * pi's transport, the assistant message, our extraction, our classifier. A
 * provider hivemind is willing to spawn without any capture has never had that
 * path exercised.
 */
export function fixtureRoot(): string {
  return fileURLToPath(new URL("../../fixtures/rpc-errors/", import.meta.url));
}

/**
 * The classes a provider must have captured before it can carry cards.
 *
 * Only AUTH, because only AUTH can be provoked for free: a wrong key is
 * refused before a token is billed. A spent balance and a throttle cannot be
 * ordered on demand — DeepSeek documents no request-rate limit at all and
 * queues instead of answering 429, and no API reports the account balance — so
 * requiring them here would have parked every metered provider behind a
 * fixture nobody can produce, which is a human decision about nothing.
 *
 * What still guarantees recognition for the classes not captured here:
 * `classify.test.ts` asserts pi's own cross-provider wording tables
 * (`isTerminalRateLimitError`, `RETRYABLE_PROVIDER_ERROR_PATTERN`) rule by
 * rule, so a wording pi knows can never fall through, and UNKNOWN fails
 * closed. The spend exposure a real quota would have bounded is bounded
 * directly instead, by `cost.perCardUsdCeiling`.
 */
export const REQUIRED_ERROR_CLASSES: readonly ErrorClass[] = ["AUTH"];

export function capturedProviders(): string[] {
  try {
    return readdirSync(fixtureRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    // The directory is part of the repository; its absence means a checkout
    // problem, and every caller reports it as "nothing captured".
    return [];
  }
}

export interface CapturedFailure {
  fixture: string;
  message: string;
  class: ErrorClass;
}

export function capturedFailures(provider: string): CapturedFailure[] {
  const directory = join(fixtureRoot(), provider);
  let files: string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const failures: CapturedFailure[] = [];
  for (const file of files.toSorted()) {
    const parsed = JSON.parse(readFileSync(join(directory, file), "utf8")) as { events: RpcEvent[] };
    const failure = extractFailure(parsed.events);
    if (!failure) continue;
    failures.push({
      fixture: file.replace(/\.json$/, ""),
      message: failure.errorMessage,
      class: classifyError(failure.errorMessage).class,
    });
  }
  return failures;
}

/**
 * Startup gate: a provider may not carry cards until a real failure of its own
 * has been captured and is recognised. It proves the whole extraction path
 * works for that provider — its error surface, its wording, our classifier —
 * on the one class that can be provoked without spending anything.
 */
export function assertErrorFixtureCoverage(chain: readonly string[]): void {
  const gaps: string[] = [];
  for (const provider of chain) {
    const covered = new Set(capturedFailures(provider).map((failure) => failure.class));
    const missing = REQUIRED_ERROR_CLASSES.filter((required) => !covered.has(required));
    if (missing.length > 0) gaps.push(`${provider}: ${missing.join(", ")}`);
  }
  if (gaps.length > 0) {
    throw new Error(
      `no captured error fixture classifies as these for ${gaps.join("; ")}` +
      ` (capture them under fixtures/rpc-errors/<provider>/ from a real failure)`,
    );
  }
}
