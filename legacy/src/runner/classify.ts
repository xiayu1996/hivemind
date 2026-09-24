export type ErrorClass =
  | "AUTH"
  | "QUOTA"
  | "RATE_LIMIT"
  | "INVALID_REQUEST"
  | "SERVER"
  | "TIMEOUT"
  | "TRANSPORT"
  | "UNKNOWN";

export interface Classification {
  class: ErrorClass;
  /** Same session, same model: the stream broke, the conversation did not. */
  retryable: boolean;
  /** Needs a human to fix credentials or billing; retrying cannot help. */
  needsHuman: boolean;
}

/**
 * Ordered first-match rules. Order is load-bearing, not cosmetic: provider
 * payloads overlap, so an insufficient_quota body also carries HTTP 429 and an
 * auth failure is reported as an invalid_request_error. QUOTA must be tested
 * before RATE_LIMIT — reading a spent quota as mere throttling produces a worker
 * that waits forever for a window that will never open.
 *
 * The wordings come from pi's own provider layer rather than from guesswork: it
 * ships `isTerminalRateLimitError` (the billing family that must never be read
 * as throttling) and `RETRYABLE_PROVIDER_ERROR_PATTERN` (about forty transient
 * phrasings), both accumulated across the providers pi drives. Every entry in
 * both is asserted in `classify.test.ts`, so a pi upgrade that adds a wording
 * shows up as a failing test rather than as an UNKNOWN in production.
 *
 * The gap that motivated harvesting them: a spent balance phrased "quota
 * exceeded" or "available balance" matched no rule here, and since the same
 * response carries HTTP 429, RATE_LIMIT claimed it — the exact misread this
 * ordering exists to prevent, reached through a wording nobody had captured.
 */
const RULES: Array<{ class: ErrorClass; pattern: RegExp }> = [
  // pi's isTerminalRateLimitError family, plus each provider's own phrasing of
  // a spent balance. Terminal: no window reopens these, a person has to act.
  { class: "QUOTA", pattern: /insufficient_quota|quota exceeded|exceeded your current quota|usage ?limit|available balance|insufficient[_ ]balance|run out of balance|out of budget|billing|^402\b|\b402:/i },
  { class: "AUTH", pattern: /^401\b|\b401:|^403\b|\b403:|invalid_api_key|invalid[_ ]?token|unauthorized|authentication|permission denied|invalid_grant/i },
  { class: "RATE_LIMIT", pattern: /rate.?limit|too many requests|ResourceExhausted|^429\b|\b429:/i },
  { class: "INVALID_REQUEST", pattern: /^400\b|\b400:|^422\b|\b422:|invalid_value|invalid parameters|context_length_exceeded/i },
  { class: "SERVER", pattern: /^5\d\d\b|\b5\d\d:|server.?error|internal.?error|provider.?returned.?error|overloaded|service.?unavailable|bad gateway/i },
  { class: "TIMEOUT", pattern: /timed? out|timeout|ETIMEDOUT|deadline exceeded/i },
  // pi's RETRYABLE_PROVIDER_ERROR_PATTERN, minus the entries the classes above
  // already claim. A broken stream is retryable in the same session; the
  // classes above are not, so anything left here has to be genuine breakage.
  { class: "TRANSPORT", pattern: /connection.?(error|refused|lost|ended)|upstream.?connect|network.?error|websocket.?(closed|error)|socket hang up|socket connection was closed|other side closed|reset before headers|ended without|stream ended before|http2 request did not get a response|request buffer limit|terminated|premature close|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|network/i },
];

const PROFILE: Record<ErrorClass, Omit<Classification, "class">> = {
  AUTH: { retryable: false, needsHuman: true },
  QUOTA: { retryable: false, needsHuman: true },
  RATE_LIMIT: { retryable: false, needsHuman: false },
  INVALID_REQUEST: { retryable: false, needsHuman: false },
  SERVER: { retryable: true, needsHuman: false },
  TIMEOUT: { retryable: true, needsHuman: false },
  TRANSPORT: { retryable: true, needsHuman: false },
  // Fail closed. Every wording pi's provider layer knows is matched above, so
  // reaching UNKNOWN means a provider said something nothing has ever seen.
  // Treated as transient it would be retried quietly forever against a fault
  // nobody can name; treated as needing a person it stops and asks. The known
  // set is what keeps this from firing on ordinary breakage.
  UNKNOWN: { retryable: false, needsHuman: true },
};

export function classifyError(errorMessage: string | null | undefined): Classification {
  if (typeof errorMessage !== "string" || errorMessage.length === 0) {
    return { class: "UNKNOWN", ...PROFILE.UNKNOWN };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(errorMessage)) return { class: rule.class, ...PROFILE[rule.class] };
  }
  return { class: "UNKNOWN", ...PROFILE.UNKNOWN };
}
