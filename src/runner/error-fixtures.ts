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
 * They exist because the classifier reads text: every provider phrases a spent
 * balance and a throttle differently, and reading one as the other makes a
 * worker wait for a window that will never open. A provider hivemind is
 * willing to spawn without these has an unproven failure path.
 */
export function fixtureRoot(): string {
  return fileURLToPath(new URL("../../fixtures/rpc-errors/", import.meta.url));
}

/** The classes a provider must have captured before it can carry cards. */
export const REQUIRED_ERROR_CLASSES: readonly ErrorClass[] = ["AUTH", "QUOTA", "RATE_LIMIT"];

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
 * Startup gate: a provider may not carry cards until its own failure wordings
 * have been captured and are recognised. Without it, adding a provider to the
 * chain is enough to get a card assigned to one whose quota message the
 * classifier will read as UNKNOWN.
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
