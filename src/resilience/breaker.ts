import { classifyError, type ErrorClass } from "./classify.ts";
import { backoffCeilingMs, readResetWindow, type ResetWindow } from "./reset-window.ts";

/** Nothing here produces `half_open`; the stored record allows it, and every
 * reader below treats it as open. */
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
  /** When this record last changed. After a failure it is the instant
   * `lastError` was produced, which a relative window in it counts from. */
  updatedAt: number;
}

export interface BreakerPolicy {
  /** Consecutive transient failures on one provider before its breaker opens
   * and the chain drops that node. */
  readonly failureThreshold: number;
  /** How long a breaker stays open after transient failures, before a probe may run. */
  readonly transientOpenMs: number;
  /** How long a breaker stays open after a rate limit that named no window of its own. */
  readonly rateLimitOpenMs: number;
  /** Windows the provider named that reopen within this are waited out;
   * longer ones fail over to the next provider. */
  readonly deferWithinMinutes: number;
  /** How long a breaker stays open after a subscription usage limit that named
   * no window. A credentials probe cannot tell when the window reopens, so a
   * real dispatch after this hold is the test. */
  readonly quotaHoldMs: number;
  /** Ceiling for the doubling of that hold; without one the backoff would
   * outlive any real window. */
  readonly quotaHoldMaxMs: number;
}

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = Object.freeze({
  failureThreshold: 3,
  transientOpenMs: 60_000,
  rateLimitOpenMs: 30_000,
  deferWithinMinutes: 15,
  quotaHoldMs: 30 * 60_000,
  quotaHoldMaxMs: 4 * 3_600_000,
});

/**
 * Each further windowless usage limit doubles the hold. The first hold is a
 * guess: the provider named no window, so the only way to learn it reopened is
 * to spend a dispatch on it. Holding the same 30 minutes forever spends one
 * every 30 minutes for as long as the account stays spent, which is how a quiet
 * weekend burns a day of quota on probes alone.
 */
function windowlessQuotaHold(
  policy: BreakerPolicy,
  consecutiveFailures: number,
  window: ResetWindow | null,
): number {
  const ceiling = backoffCeilingMs(window, policy.quotaHoldMaxMs);
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 20);
  return Math.min(policy.quotaHoldMs * 2 ** exponent, Math.max(policy.quotaHoldMs, ceiling));
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
 * (see `reset-window.ts`); a duration it reports counts from the event and
 * never from the moment this is read.
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
  const window = readResetWindow(errorMessage, at);
  if (classification.class === "QUOTA") {
    if (window !== null && window.resetAt !== null) return opened(window.resetAt, false);
    // A subscription usage limit reopens on its own even when the message
    // names no instant; nothing can tell when, so the breaker holds and a real
    // dispatch is the test. A named window length says how long these windows
    // are, not when this one ends, so it bounds the backoff rather than
    // becoming the wait. A spent balance ("insufficient_quota") does not come
    // back without a person.
    if (/usage limit/i.test(errorMessage) || (window !== null && window.windowMs !== null)) {
      return opened(at + windowlessQuotaHold(policy, consecutiveFailures, window), false);
    }
    return opened(null, true);
  }
  if (classification.class === "RATE_LIMIT") {
    // A 429 that names when to come back beats our own default: the provider
    // is the only party that knows its window.
    return opened(window?.resetAt ?? at + policy.rateLimitOpenMs, false);
  }
  if (consecutiveFailures >= policy.failureThreshold) {
    // An unrecognised wording gets no self-healing window: nothing knows what
    // would have to change for the next attempt to differ, so reopening on a
    // timer repeats the failure while telling nobody. One odd string is still
    // tolerated; it takes as many consecutive failures as any other fault.
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
  healthByProvider: ReadonlyMap<string, ProviderHealth>,
  at: number,
): string[] {
  return chain.filter((provider) => usable(healthByProvider.get(provider), at));
}

/**
 * The soonest instant at which waiting alone returns a provider of the chain
 * to service: the earliest `retryAt` among its open providers that do not
 * need a person. Null when no open provider reopens on its own, so there is
 * nothing to wait for.
 */
export function earliestRetryAt(
  chain: readonly string[],
  healthByProvider: ReadonlyMap<string, ProviderHealth>,
): number | null {
  let earliest: number | null = null;
  for (const provider of chain) {
    const health = healthByProvider.get(provider);
    if (health === undefined || health.state === "closed" || health.needsHuman || health.retryAt === null) continue;
    if (earliest === null || health.retryAt < earliest) earliest = health.retryAt;
  }
  return earliest;
}

/**
 * Whether work that just failed on this provider should wait for it instead of
 * failing over to the next one in the chain.
 *
 * Only a reopening the provider named for itself is waited for, and only when
 * it falls within `deferWithinMinutes` of `at`. The breaker's own holds are
 * guesses: waiting on a guess idles the work, where failing over costs only a
 * cheaper model. Nothing that needs a person is waited for.
 *
 * `health` is the record `onProviderFailure` returned for that failure: its
 * window is read again from `lastError` at `updatedAt`, the failure's own
 * instant, and counts only when it is the instant the breaker holds the
 * provider until. So when this answers yes, `health.retryAt` is when to resume.
 */
export function shouldWaitFor(health: ProviderHealth, at: number, policy: BreakerPolicy): boolean {
  if (health.needsHuman || health.retryAt === null) return false;
  if (readResetWindow(health.lastError, health.updatedAt)?.resetAt !== health.retryAt) return false;
  return health.retryAt - at <= policy.deferWithinMinutes * 60_000;
}
