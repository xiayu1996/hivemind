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
 * Ordered first-match rules over the `errorMessage` of a failed assistant
 * message. Order is load-bearing: provider payloads overlap, so a spent quota
 * also carries HTTP 429 and an auth failure arrives as an
 * invalid_request_error. QUOTA must be tested before RATE_LIMIT: reading a
 * spent quota as throttling parks a worker waiting for a window that never
 * opens.
 *
 * The wordings come from pi, not from guesswork. pi-ai builds
 * `isRetryableAssistantError` (`dist/utils/retry.js`) from two lists it has
 * accumulated across every provider it drives: a terminal quota and billing
 * family that must never be read as throttling, and some forty transient
 * phrasings. `classify.test.ts` reads both lists out of the installed SDK and
 * asserts every entry, so an upgrade that adds a wording fails a test instead
 * of surfacing as UNKNOWN in production. Provoking failures is no substitute:
 * it pays a provider to refuse us, and a provider that queues instead of
 * refusing never yields the string at all.
 *
 * A status code counts only where pi's composers put one: leading an SDK
 * message ("503 status code (no body)"), before the body ("503: {...}"), or
 * after a provider prefix ("OpenAI API error (503): {...}"). Anywhere else a
 * three-digit number is as likely a token count or a request id.
 */
const RULES: ReadonlyArray<{ class: ErrorClass; pattern: RegExp }> = [
  // pi's terminal family plus each provider's own phrasing of a spent balance.
  // No window reopens these; a person has to act. A spent balance worded
  // "quota exceeded" once matched nothing here, so RATE_LIMIT claimed it by
  // its 429: the misread this ordering exists to prevent, reached through an
  // uncaptured wording.
  { class: "QUOTA", pattern: /insufficient_quota|quota exceeded|exceeded your current quota|usage ?limit|available balance|insufficient[_ ]balance|run out of balance|out of budget|billing|^402\b|\b402:|\(402\)/i },
  { class: "AUTH", pattern: /^40[13]\b|\b40[13]:|\(40[13]\)|invalid_api_key|invalid[_ ]?token|unauthorized|authentication|permission denied|invalid_grant/i },
  // "retry delay" is pi reporting that a provider asked for a longer wait than
  // pi sleeps for ("Server requested 3600s retry delay (max: 60s)"). The
  // provider named its window, so it is waited out, not retried in session.
  { class: "RATE_LIMIT", pattern: /rate.?limit|too many requests|ResourceExhausted|retry delay|^429\b|\b429:|\(429\)/i },
  { class: "INVALID_REQUEST", pattern: /^(?:400|422)\b|\b(?:400|422):|\((?:400|422)\)|invalid_value|invalid parameters|context_length_exceeded/i },
  { class: "SERVER", pattern: /^5\d\d\b|\b5\d\d:|\(5\d\d\)|server.?error|internal.?error|provider.?returned.?error|overloaded|currently experiencing high demand|service.?unavailable|bad gateway/i },
  { class: "TIMEOUT", pattern: /timed? out|timeout|ETIMEDOUT|deadline exceeded/i },
  // The rest of pi's transient list. Everything that is not breakage has been
  // claimed above, so what is left is a broken stream: retryable in the same
  // session.
  { class: "TRANSPORT", pattern: /connection.?(error|refused|lost|ended)|upstream.?connect|network.?error|websocket.?(closed|error)|socket hang up|socket connection was closed|other side closed|reset before headers|ended without|stream ended before|http2 request did not get a response|request buffer limit|terminated|premature close|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|network/i },
  // An explicit invitation to retry that names no cause, as OpenAI Responses
  // and Bedrock send mid-stream. Last, so a cause named anywhere in the same
  // message decides the class instead.
  { class: "SERVER", pattern: /you can retry your request|try your request again|please retry your request/i },
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
  // reaching UNKNOWN means a provider said something nothing has seen before.
  // Read as transient, it would be retried quietly forever against a fault
  // nobody can name (a spent DeepSeek balance, 402 "Insufficient Balance", once
  // was); read as needing a person, it stops and asks. The known set is what
  // keeps this from firing on ordinary breakage.
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
