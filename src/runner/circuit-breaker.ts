import type { ConfigStore } from "../config/store.js";
import { classifyError, type ErrorClass } from "./classify.js";
import { parseUsageLimit } from "./usage-limit.js";

export type BreakerState = "closed" | "open" | "half_open";

export interface ProviderHealth {
  provider: string;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  /** The instant a probe may run. Null while open means only a human can clear it. */
  retryAt: number | null;
  /** Credentials or billing must be fixed; waiting cannot help. */
  needsHuman: boolean;
  lastErrorClass: ErrorClass | null;
  lastError: string | null;
  updatedAt: number;
}

export interface BreakerPolicy {
  /** Consecutive transient failures tolerated before the provider is dropped. */
  failureThreshold: number;
  transientOpenMs: number;
  rateLimitOpenMs: number;
  /** Usage-limit windows at or under this are worth waiting out. */
  deferWithinMinutes: number;
}

export interface ProviderFailure {
  at: number;
  errorMessage: string;
  policy: BreakerPolicy;
}

export function closedHealth(provider: string, at: number): ProviderHealth {
  return {
    provider,
    state: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    retryAt: null,
    needsHuman: false,
    lastErrorClass: null,
    lastError: null,
    updatedAt: at,
  };
}

/**
 * One failure moves the provider's health. The window a provider names for
 * itself always wins over a policy default: a usage limit reports the minutes
 * it needs, and those minutes are relative to the event, not to now.
 */
export function onProviderFailure(health: ProviderHealth, input: ProviderFailure): ProviderHealth {
  const { at, errorMessage, policy } = input;
  const classification = classifyError(errorMessage);
  const consecutiveFailures = health.consecutiveFailures + 1;
  const base = {
    ...health,
    consecutiveFailures,
    lastErrorClass: classification.class,
    lastError: errorMessage,
    updatedAt: at,
  };
  const opened = (retryAt: number | null, needsHuman: boolean): ProviderHealth => ({
    ...base,
    state: "open",
    openedAt: health.state === "closed" ? at : health.openedAt ?? at,
    retryAt,
    needsHuman,
  });

  if (classification.class === "AUTH") return opened(null, true);
  if (classification.class === "QUOTA") {
    const limit = parseUsageLimit(errorMessage, at);
    // A usage window reopens on its own; a spent balance does not.
    return limit?.resetAt === null || limit === null
      ? opened(null, true)
      : opened(limit.resetAt, false);
  }
  if (classification.class === "RATE_LIMIT") return opened(at + policy.rateLimitOpenMs, false);
  if (consecutiveFailures >= policy.failureThreshold) {
    return opened(at + policy.transientOpenMs, classification.needsHuman);
  }
  return { ...base, state: health.state === "open" ? "open" : "closed" };
}

export function onProviderSuccess(health: ProviderHealth, at: number): ProviderHealth {
  return {
    ...health,
    state: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    retryAt: null,
    needsHuman: false,
    lastErrorClass: null,
    lastError: null,
    updatedAt: at,
  };
}

/** Whether the breaker may spend a probe on this provider now. A failure only a
 * human can clear is still probed: the probe is how we notice they fixed it. */
export function probeDue(health: ProviderHealth, at: number): boolean {
  if (health.state === "closed") return false;
  return health.retryAt === null || at >= health.retryAt;
}

function usable(health: ProviderHealth | undefined, at: number): boolean {
  if (!health || health.state === "closed") return true;
  return health.retryAt !== null && at >= health.retryAt;
}

/** The chain minus the providers that are open right now, in chain order. One
 * broken provider only loses its own node. */
export function usableProviders(
  chain: readonly string[],
  healths: ReadonlyMap<string, ProviderHealth>,
  at: number,
): string[] {
  return chain.filter((provider) => usable(healths.get(provider), at));
}

/** Intake stops only when nothing in the chain can serve a card. */
export function intakeHalted(
  chain: readonly string[],
  healths: ReadonlyMap<string, ProviderHealth>,
  at: number,
): boolean {
  return chain.length > 0 && usableProviders(chain, healths, at).length === 0;
}

/** The live policy. Read per decision so a console change takes effect on the
 * next one rather than at the next restart. */
export async function breakerPolicy(config: ConfigStore): Promise<BreakerPolicy> {
  await config.reload();
  return {
    failureThreshold: config.get("provider.failureThreshold"),
    transientOpenMs: config.get("provider.transientOpenMs"),
    rateLimitOpenMs: config.get("provider.rateLimitOpenMs"),
    deferWithinMinutes: config.get("model.deferIfResetWithinMin"),
  };
}
