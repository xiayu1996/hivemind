// Parser for pi's ChatGPT usage-limit message (PoC-C2).
//
// pi flattens the provider error into a single human-readable string before it
// reaches the RPC event stream, so the reset window must be recovered by regex.
// The template is fixed in pi 0.84.3:
//
//   const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
//   const mins = err.resets_at ? Math.max(0, Math.round((err.resets_at*1000 - Date.now())/60000)) : undefined;
//   const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
//   friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
//
// Note the reset window is already minutes-from-now at the moment pi built the
// string, not an absolute timestamp: it must be anchored to the event's own time.

const USAGE_LIMIT = /You have hit your ChatGPT usage limit(?: \(([^)]+?) plan\))?\.(?: Try again in ~(\d+) min\.)?/;

export function parseUsageLimit(errorMessage, observedAtMs = Date.now()) {
  if (typeof errorMessage !== "string") return null;
  const m = USAGE_LIMIT.exec(errorMessage);
  if (!m) return null;
  const minutes = m[2] === undefined ? null : Number(m[2]);
  return {
    kind: "usage_limit",
    plan: m[1] ?? null,
    resetMinutes: minutes,
    resetAtMs: minutes === null ? null : observedAtMs + minutes * 60_000,
    // 02 文档 §failover: defer and wait when the window is short, switch provider otherwise.
    action: minutes !== null && minutes <= 15 ? "defer" : "failover",
  };
}

export function isUsageLimit(errorMessage) {
  return typeof errorMessage === "string" && USAGE_LIMIT.test(errorMessage);
}
