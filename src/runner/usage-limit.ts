/**
 * pi flattens a provider usage-limit error into one human-readable string
 * before it reaches the RPC event stream, so the reset window is only
 * recoverable by regex. The template is fixed in pi 0.84.3:
 *
 *   const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
 *   const mins = err.resets_at
 *     ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
 *     : undefined;
 *   const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
 *   `You have hit your ChatGPT usage limit${plan}.${when}`.trim()
 *
 * The minutes are already relative to the moment pi built the string, not an
 * absolute timestamp, so they must be anchored to the event's own time. There
 * is deliberately no default for `eventTimeMs`: anchoring to "when we read it"
 * computes the wrong window for any event that waited in a backlog.
 */
const USAGE_LIMIT = /You have hit your ChatGPT usage limit(?: \(([^)]+?) plan\))?\.(?: Try again in ~(\d+) min\.)?/;

export interface UsageLimit {
  plan: string | null;
  /** Minutes remaining as pi measured them, or null when it reported no window. */
  resetMinutes: number | null;
  /** Absolute instant the window reopens, or null when there is no window. */
  resetAt: number | null;
}

export function parseUsageLimit(errorMessage: string | null | undefined, eventTimeMs: number): UsageLimit | null {
  if (typeof errorMessage !== "string") return null;
  const match = USAGE_LIMIT.exec(errorMessage);
  if (!match) return null;
  const minutes = match[2] === undefined ? null : Number(match[2]);
  return {
    plan: match[1] ?? null,
    resetMinutes: minutes,
    resetAt: minutes === null ? null : eventTimeMs + minutes * 60_000,
  };
}

export function isUsageLimit(errorMessage: string | null | undefined): boolean {
  return typeof errorMessage === "string" && USAGE_LIMIT.test(errorMessage);
}

/**
 * A short window is cheaper to wait out than to fail over; a long or unknown
 * one is not. Never a silent retry either way — the caller defers explicitly or
 * moves the tier sideways.
 */
export function usageLimitAction(limit: UsageLimit, deferWithinMinutes: number): "defer" | "failover" {
  if (limit.resetMinutes === null) return "failover";
  return limit.resetMinutes <= deferWithinMinutes ? "defer" : "failover";
}
