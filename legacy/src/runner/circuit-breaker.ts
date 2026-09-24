import type { ConfigStore } from "../config/store.js";
import { classifyError, type ErrorClass } from "./classify.js";
import { backoffCeilingMs, readResetWindow, type ResetWindow } from "./reset-window.js";

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
  /** How long a usage limit that named no window is held before dispatch tries
   * again. Absent for callers built before the field existed. */
  quotaHoldMs?: number;
  /** Ceiling for the doubling of that hold. */
  quotaHoldMaxMs?: number;
}

const DEFAULT_QUOTA_HOLD_MS = 30 * 60_000;
const DEFAULT_QUOTA_HOLD_MAX_MS = 4 * 3_600_000;

/**
 * Each further windowless usage limit doubles the hold. The first hold is a
 * guess: the provider named no window, so the only way to learn the window has
 * reopened is to spend a dispatch on it. Holding the same 30 minutes forever
 * spends one every 30 minutes for as long as the account stays spent, which is
 * how a quiet weekend burns a day of quota on probes alone.
 */
function windowlessQuotaHold(
  policy: BreakerPolicy,
  consecutiveFailures: number,
  window: ResetWindow | null,
): number {
  const base = policy.quotaHoldMs ?? DEFAULT_QUOTA_HOLD_MS;
  const ceiling = backoffCeilingMs(window, policy.quotaHoldMaxMs ?? DEFAULT_QUOTA_HOLD_MAX_MS);
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 20);
  return Math.min(base * 2 ** exponent, Math.max(base, ceiling));
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
 * itself always wins over a policy default, in whichever shape it named it
 * (see `reset-window.ts`); a duration it reports is relative to the event and
 * never to the moment this is read.
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
  // What the provider itself said about its window, whichever shape it said it
  // in. Read once here, from the message, at the event's own time.
  const window = readResetWindow(errorMessage, at);
  if (classification.class === "QUOTA") {
    if (window !== null && window.resetAt !== null) return opened(window.resetAt, false);
    // A subscription usage limit reopens on its own even when the message
    // names no instant; nothing can tell when, so the breaker holds and a real
    // dispatch is the test. A named window length does not say when this one
    // ends, only how long these windows are, so it bounds the backoff rather
    // than becoming the wait. A spent balance ("insufficient_quota") does not
    // come back without a person.
    if (/usage limit/i.test(errorMessage) || (window !== null && window.windowMs !== null)) {
      return opened(at + windowlessQuotaHold(policy, consecutiveFailures, window), false);
    }
    return opened(null, true);
  }
  if (classification.class === "RATE_LIMIT") {
    // A 429 that names when to come back is worth more than our own default:
    // the provider is the only party that knows its window.
    return opened(window?.resetAt ?? at + policy.rateLimitOpenMs, false);
  }
  if (consecutiveFailures >= policy.failureThreshold) {
    // An unrecognised wording gets no self-healing window: nothing knows what
    // would have to change for the next attempt to differ, so reopening on a
    // timer just repeats the failure while telling nobody. One odd string is
    // still tolerated — it takes the same consecutive failures as any other
    // fault to park the provider.
    if (classification.class === "UNKNOWN") return opened(null, true);
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
    quotaHoldMs: config.get("provider.quotaHoldMs"),
    quotaHoldMaxMs: config.get("provider.quotaHoldMaxMs"),
  };
}
