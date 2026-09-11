import { describe, expect, it } from "vitest";
import { classifyError } from "./classify.js";
import { capturedFailures, capturedProviders } from "./error-fixtures.js";

/**
 * Every captured wording, per provider, with the class it must land in. A
 * fixture nobody asserts on is a provider wording the classifier has never been
 * run against, which is exactly how the Codex usage-limit text reached
 * production unclassified — so the table and the directories are held to each
 * other in both directions.
 */
const EXPECTED: Record<string, Array<[string, string]>> = {
  "command-code": [
    ["auth", "AUTH"],
  ],
  deepseek: [
    ["auth", "AUTH"],
  ],
  "openai-codex": [
    ["auth", "AUTH"],
    ["quota", "QUOTA"],
    ["rate_limit", "RATE_LIMIT"],
    ["invalid_request", "INVALID_REQUEST"],
    ["server", "SERVER"],
    ["transport", "TRANSPORT"],
    ["mid_stream_drop", "TRANSPORT"],
    ["usage_limit_codex", "QUOTA"],
  ],
};

describe("captured fixtures classify as expected", () => {
  it("asserts on every provider that has captured wordings", () => {
    expect(capturedProviders()).toEqual(Object.keys(EXPECTED).toSorted());
  });

  for (const [provider, cases] of Object.entries(EXPECTED)) {
    describe(provider, () => {
      const captured = capturedFailures(provider);

      it("claims every fixture captured for this provider", () => {
        expect(captured.map((failure) => failure.fixture).toSorted())
          .toEqual(cases.map(([fixture]) => fixture).toSorted());
      });

      for (const [fixture, expected] of cases) {
        it(`${fixture} -> ${expected}`, () => {
          expect(captured.find((failure) => failure.fixture === fixture)?.class).toBe(expected);
        });
      }
    });
  }
});

/**
 * pi's own provider layer carries two accumulated wording lists:
 * `isTerminalRateLimitError` for the billing family, and
 * `RETRYABLE_PROVIDER_ERROR_PATTERN` for transient breakage. They were built up
 * across every provider pi drives, so they are a far better source than
 * provoking failures — provoking costs real money to be refused, and a provider
 * that queues instead of refusing never yields the string at all.
 *
 * Every entry is asserted here. A pi upgrade that adds a wording then surfaces
 * as a failing test rather than as an UNKNOWN in production.
 */
describe("wordings pi's provider layer already knows", () => {
  // isTerminalRateLimitError: terminal, so QUOTA. Reading any of these as
  // RATE_LIMIT parks a worker against a window that never reopens.
  const TERMINAL_BILLING = [
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "Monthly usage limit reached",
    "available balance",
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing",
  ];

  it.each(TERMINAL_BILLING)("%s is QUOTA and needs a person", (wording) => {
    const classification = classifyError(wording);
    expect(classification.class).toBe("QUOTA");
    expect(classification.needsHuman).toBe(true);
  });

  it.each(TERMINAL_BILLING)("%s stays QUOTA even carried on a 429, as pi itself guards", (wording) => {
    // pi: `if (status === 429 && isTerminalRateLimitError(text)) return false`.
    expect(classifyError(`429: {"message":"${wording}"}`).class).toBe("QUOTA");
  });

  // RETRYABLE_PROVIDER_ERROR_PATTERN: transient, so retryable in the same
  // session. QUOTA and AUTH are deliberately absent from this list.
  const RETRYABLE = [
    "overloaded", "rate.limit", "rate limit", "too many requests", "429", "500", "502", "503",
    "504", "524", "service unavailable", "server error", "internal error",
    "provider returned error", "exceeded request buffer limit while retrying upstream",
    "network error", "connection error", "connection refused", "connection lost",
    "other side closed", "fetch failed", "getaddrinfo", "ENOTFOUND", "EAI_AGAIN",
    "upstream connect", "reset before headers", "socket hang up",
    "socket connection was closed", "timed out", "time out", "timeout", "terminated",
    "websocket closed", "websocket error", "ended without",
    "stream ended before message_stop", "stream ended before a terminal response event",
    "http2 request did not get a response", "ResourceExhausted",
  ];

  it.each(RETRYABLE)("%s is recognised, never UNKNOWN", (wording) => {
    expect(classifyError(wording).class).not.toBe("UNKNOWN");
  });

  it.each(RETRYABLE.filter((wording) => !/^(429|rate|too many|ResourceExhausted)/i.test(wording)))(
    "%s is retryable in the same session", (wording) => {
      expect(classifyError(wording).retryable).toBe(true);
    });

  // Published error tables, for wordings that cannot be provoked without paying
  // a provider to refuse us.
  const PUBLISHED: Array<[string, string, string]> = [
    ["deepseek", '402: {"message":"Insufficient Balance"}', "QUOTA"],
    ["deepseek", '429: {"message":"You are sending requests too quickly"}', "RATE_LIMIT"],
    ["deepseek", '422: {"message":"Your request contains invalid parameters"}', "INVALID_REQUEST"],
    ["deepseek", '503: {"message":"The server is overloaded due to high traffic"}', "SERVER"],
    ["openai-codex", "You have hit your ChatGPT usage limit (plus plan). Try again in ~57 min.", "QUOTA"],
  ];

  it.each(PUBLISHED)("%s: %s -> %s", (_provider, wording, expected) => {
    expect(classifyError(wording).class).toBe(expected);
  });
});

describe("rule ordering", () => {
  it("reads a spent quota as QUOTA even though it is also a 429", () => {
    // Getting this backwards makes a worker wait for a window that never opens.
    const message = '429: {"message":"You exceeded your current quota","code":"insufficient_quota"}';
    expect(classifyError(message).class).toBe("QUOTA");
  });

  it("reads a ChatGPT usage limit as QUOTA rather than a rate limit", () => {
    expect(classifyError("You have hit your ChatGPT usage limit (plus plan). Try again in ~47 min.").class)
      .toBe("QUOTA");
  });

  // DeepSeek phrases both of these unlike every other provider, and neither can
  // be provoked on a funded account: a 402 needs a drained balance and 45
  // simultaneous requests did not draw a 429. The wordings come from DeepSeek's
  // published error-code table, so they are asserted as rules rather than
  // installed as captured fixtures.
  it("reads DeepSeek's spent balance as QUOTA, not as the UNKNOWN that tells nobody", () => {
    const spent = '402: {"message":"Insufficient Balance","type":"insufficient_balance"}';
    expect(classifyError(spent).class).toBe("QUOTA");
    expect(classifyError(spent).needsHuman).toBe(true);
  });

  it("reads DeepSeek's invalid parameters as INVALID_REQUEST", () => {
    expect(classifyError('422: {"message":"Your request contains invalid parameters"}').class)
      .toBe("INVALID_REQUEST");
  });

  it("still reads plain throttling as RATE_LIMIT", () => {
    expect(classifyError('429: {"code":"rate_limit_exceeded"}').class).toBe("RATE_LIMIT");
  });
});

describe("recovery profile", () => {
  it("marks stream breakage retryable in the same session", () => {
    expect(classifyError("Connection error.")).toMatchObject({ retryable: true, needsHuman: false });
  });

  it("marks credential and quota failures as needing a human", () => {
    expect(classifyError("401: invalid_api_key")).toMatchObject({ retryable: false, needsHuman: true });
    expect(classifyError("insufficient_quota")).toMatchObject({ retryable: false, needsHuman: true });
  });

  it("does not retry a malformed request, which would just fail again", () => {
    expect(classifyError("400: invalid_value").retryable).toBe(false);
  });

  it("returns UNKNOWN, not a guess, for text it does not recognise", () => {
    expect(classifyError("something entirely new").class).toBe("UNKNOWN");
    expect(classifyError(null).class).toBe("UNKNOWN");
    expect(classifyError("").class).toBe("UNKNOWN");
  });
});
