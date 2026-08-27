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
 */
const RULES: Array<{ class: ErrorClass; pattern: RegExp }> = [
  { class: "QUOTA", pattern: /insufficient_quota|exceeded your current quota|usage limit/i },
  { class: "AUTH", pattern: /^401\b|\b401:|invalid_api_key|unauthorized|authentication|invalid_grant/i },
  { class: "RATE_LIMIT", pattern: /rate_limit_exceeded|rate limit reached|^429\b|\b429:/i },
  { class: "INVALID_REQUEST", pattern: /^400\b|\b400:|invalid_value|context_length_exceeded/i },
  { class: "SERVER", pattern: /^5\d\d\b|\b5\d\d:|server_error|overloaded|bad gateway/i },
  { class: "TIMEOUT", pattern: /timed out|timeout|ETIMEDOUT|deadline exceeded/i },
  { class: "TRANSPORT", pattern: /connection error|terminated|socket hang up|ECONNRESET|EPIPE|fetch failed|network|premature close/i },
];

const PROFILE: Record<ErrorClass, Omit<Classification, "class">> = {
  AUTH: { retryable: false, needsHuman: true },
  QUOTA: { retryable: false, needsHuman: true },
  RATE_LIMIT: { retryable: false, needsHuman: false },
  INVALID_REQUEST: { retryable: false, needsHuman: false },
  SERVER: { retryable: true, needsHuman: false },
  TIMEOUT: { retryable: true, needsHuman: false },
  TRANSPORT: { retryable: true, needsHuman: false },
  UNKNOWN: { retryable: false, needsHuman: false },
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
