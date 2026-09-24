import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { describe, expect, it } from "vitest";
import { classifyError, type ErrorClass } from "./classify.ts";

type AssistantMessage = Parameters<typeof isRetryableAssistantError>[0];

function failed(errorMessage: string): AssistantMessage {
  return { stopReason: "error", errorMessage } as AssistantMessage;
}

/**
 * pi-ai's wording lists, read from the installed SDK rather than copied, so a
 * pi upgrade that adds a wording adds a failing case here instead of an
 * UNKNOWN in production. A layout this cannot read fails the whole file on
 * purpose: the lists moved, and the classifier has to be checked again.
 */
function sdkSource(path: string): string {
  const manifest = findPackageJSON("@earendil-works/pi-ai", import.meta.url);
  if (manifest === undefined) throw new Error("@earendil-works/pi-ai is not installed");
  return readFileSync(join(dirname(manifest), path), "utf8");
}

const RETRY_SOURCE = sdkSource("dist/utils/retry.js");
const CODEX_SOURCE = sdkSource("dist/api/openai-codex-responses.js");

/** The array literal is evaluated rather than scanned, in an empty context: an
 * entry built from anything but a string literal throws instead of vanishing. */
function sharedFragments(list: string): string[] {
  const declared = new RegExp(`const ${list} = buildProviderErrorPattern\\((\\[[\\s\\S]*?\\])\\);`).exec(RETRY_SOURCE);
  if (declared === null) throw new Error(`pi-ai utils/retry.js no longer declares ${list}`);
  const fragments: unknown = runInNewContext(declared[1]!);
  if (!Array.isArray(fragments) || !fragments.every((fragment) => typeof fragment === "string")) {
    throw new Error(`pi-ai utils/retry.js ${list} is no longer a list of strings`);
  }
  return fragments;
}

/** openai-codex-responses keeps its own copies of both lists for the retry
 * loop inside its fetch. A wording added only there still reaches us once that
 * loop gives up, so the copies have to stay inside the shared lists. */
function codexFragments(helper: string): string[] {
  const body = new RegExp(`^function ${helper}\\(.*\\) \\{$([\\s\\S]*?)^\\}$`, "m").exec(CODEX_SOURCE)?.[1];
  const wordings = body === undefined ? null : /return \/([^/]+)\/i\.test\(errorText\);/.exec(body);
  if (!wordings) throw new Error(`pi-ai openai-codex-responses.js no longer words ${helper} as one regex`);
  return wordings[1]!.split("|");
}

const TERMINAL = sharedFragments("NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN");
const TRANSIENT = sharedFragments("RETRYABLE_PROVIDER_ERROR_PATTERN");

/**
 * The concrete messages a pi fragment matches. pi writes fragments as text
 * with two regex forms, an optional separator (`rate.?limit`) and an optional
 * letter (`timed? out`). Other syntax throws rather than being skipped: a
 * fragment this cannot expand is one the classifier was never checked against.
 */
function messagesMatching(fragment: string): string[] {
  if (/[\\^$*+()[\]{}|]/.test(fragment)) throw new Error(`cannot expand pi fragment ${fragment}`);
  let messages = [""];
  for (let index = 0; index < fragment.length; index += 1) {
    const character = fragment[index]!;
    const optional = fragment[index + 1] === "?";
    if (optional) index += 1;
    const forms = character === "." ? [" ", "_", "-"] : [character];
    messages = messages.flatMap((prefix) => [...forms.map((form) => prefix + form), ...(optional ? [prefix] : [])]);
  }
  return messages;
}

function casesOf(fragments: readonly string[]): Array<[fragment: string, message: string]> {
  return fragments.flatMap((fragment) =>
    messagesMatching(fragment).map((message): [string, string] => [fragment, message]));
}

/** Where a wording sits in a real errorMessage: a status code in each position
 * pi's composers put one, a phrase inside the provider's body. */
function carried(message: string): string[] {
  const body = `{"error":{"message":"request req_8f2c did not complete"}}`;
  if (/^\d{3}$/.test(message)) {
    return [`${message} status code (no body)`, `${message}: ${body}`, `OpenAI API error (${message}): ${body}`];
  }
  return [`{"error":{"message":"Upstream reported: ${message}. Request req_8f2c."}}`];
}

/**
 * pi retries these like any other transient failure. Here they are
 * throttling: waited out for their window instead of retried in the same
 * session. A new pi wording joins this set only by someone deciding it is one.
 */
const THROTTLING = new Set(["rate.?limit", "too many requests", "429", "retry delay", "ResourceExhausted"]);

describe("the wordings pi's own retry decision is built from", () => {
  it("reads every list pi builds that decision from", () => {
    expect(RETRY_SOURCE.match(/buildProviderErrorPattern\(\[/g)?.length, "a new list in pi-ai utils/retry.js needs its own assertions here")
      .toBe(2);
    expect(TERMINAL.length).toBeGreaterThan(5);
    expect(TRANSIENT.length).toBeGreaterThan(30);
  });

  it("finds nothing in openai-codex's own copies that the shared lists lack", () => {
    expect(TERMINAL).toEqual(expect.arrayContaining(codexFragments("isTerminalRateLimitError")));
    expect(TRANSIENT).toEqual(expect.arrayContaining(codexFragments("isRetryableError")));
  });

  // `isRetryableAssistantError`: a terminal wording overrides a status pi would
  // otherwise retry. Reading any of these as RATE_LIMIT parks a worker against
  // a window that never reopens.
  describe("terminal quota and billing wordings", () => {
    it("override a status pi would otherwise retry", () => {
      expect(isRetryableAssistantError(failed("429: {}"))).toBe(true);
    });

    it.each(casesOf(TERMINAL))("%s: %s is QUOTA and needs a person, even on a 429", (_fragment, message) => {
      expect(isRetryableAssistantError(failed(`429: ${message}`))).toBe(false);
      expect(classifyError(message)).toMatchObject({ class: "QUOTA", needsHuman: true });
      expect(classifyError(`429: {"error":{"message":"${message}"}}`).class).toBe("QUOTA");
      expect(classifyError(`OpenAI API error (429): {"error":{"message":"${message}"}}`).class).toBe("QUOTA");
    });
  });

  describe("transient wordings", () => {
    it.each(casesOf(TRANSIENT))("%s: %s heals without a person", (fragment, message) => {
      // The SDK itself retries this exact message, so the case is a real one.
      expect(isRetryableAssistantError(failed(message))).toBe(true);
      const classification = classifyError(message);
      expect(classification.needsHuman).toBe(false);
      if (THROTTLING.has(fragment)) expect(classification.class).toBe("RATE_LIMIT");
      else expect(classification.retryable).toBe(true);
      for (const wrapped of carried(message)) expect(classifyError(wrapped).class).toBe(classification.class);
    });
  });
});

/**
 * `errorMessage`s from real pi failure streams, verbatim: the AUTH capture of
 * every provider that has carried cards, and the openai-codex set. A wording
 * the classifier was never run against is how the Codex usage-limit text
 * reached production unclassified.
 */
const CAPTURED: Array<[provider: string, fixture: string, message: string, expected: ErrorClass]> = [
  ["command-code", "auth", `401: {"message":"Invalid 'Authorization' header or token.","type":"authentication_error","code":"UNAUTHORIZED"}`, "AUTH"],
  ["deepseek", "auth", `401: {"message":"Authentication Fails, Your api key: ****pose is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}`, "AUTH"],
  ["mimo", "auth", `401: {"message":"Invalid API Key","param":"Please provide valid API Key","code":"401","type":"invalid_key"}`, "AUTH"],
  ["openai-codex", "auth", `401: {"message":"Incorrect API key provided: mock-***. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}`, "AUTH"],
  ["openai-codex", "invalid_request", `400: {"message":"Invalid value for 'messages[0].role': expected one of 'system', 'assistant', 'user'.","type":"invalid_request_error","code":"invalid_value"}`, "INVALID_REQUEST"],
  ["openai-codex", "mid_stream_drop", "Connection error.", "TRANSPORT"],
  ["openai-codex", "quota", `429: {"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}`, "QUOTA"],
  ["openai-codex", "rate_limit", `429: {"message":"Rate limit reached for mock-1 in organization org-mock on requests per min (RPM): Limit 3, Used 3. Please try again in 20s.","type":"requests","code":"rate_limit_exceeded"}`, "RATE_LIMIT"],
  ["openai-codex", "server", `500: {"message":"The server had an error while processing your request.","type":"server_error","code":null}`, "SERVER"],
  ["openai-codex", "transport", "Connection error.", "TRANSPORT"],
  ["openai-codex", "usage_limit_codex", "Codex error: The usage limit has been reached", "QUOTA"],
];

describe("captured failures classify as expected", () => {
  it.each(CAPTURED)("%s %s -> %s", (_provider, _fixture, message, expected) => {
    expect(classifyError(message).class).toBe(expected);
  });
});

describe("wordings from outside pi's lists", () => {
  // Not a provider wording: a request that hit its own deadline says this, and
  // a cycle step asks the classifier whether it may be skipped until the next
  // pass. Read as anything but transient, it cost a whole cycle and raised a P0
  // about a request the next pass made successfully.
  it("reads a request that hit its own deadline as transient", () => {
    expect(classifyError("The operation was aborted due to timeout").retryable).toBe(true);
  });

  // The same wording, asked the other question. A background step pages a
  // person only when this says one is needed, so a link that blinked must
  // answer no, while a spent account and anything unrecognised answer yes.
  it("says who is needed, so a blink is not a page and a spent account is", () => {
    expect(classifyError("The operation was aborted due to timeout").needsHuman).toBe(false);
    expect(classifyError("Codex error: The usage limit has been reached").needsHuman).toBe(true);
    expect(classifyError("DECOMPOSE returned no candidate matching the contract").needsHuman).toBe(true);
  });

  // Published error tables, for wordings that cannot be provoked without
  // paying a provider to refuse us: a 402 needs a drained balance, and 45
  // simultaneous requests did not draw a 429 from DeepSeek.
  const PUBLISHED: Array<[provider: string, message: string, expected: ErrorClass]> = [
    ["deepseek", '402: {"message":"Insufficient Balance","type":"insufficient_balance"}', "QUOTA"],
    ["deepseek", '429: {"message":"You are sending requests too quickly"}', "RATE_LIMIT"],
    ["deepseek", '422: {"message":"Your request contains invalid parameters"}', "INVALID_REQUEST"],
    ["deepseek", '503: {"message":"The server is overloaded due to high traffic"}', "SERVER"],
    ["openai-codex", "You have hit your ChatGPT usage limit (plus plan). Try again in ~57 min.", "QUOTA"],
    ["openai-codex", "Server requested 3600s retry delay (max: 60s)", "RATE_LIMIT"],
    ["openai", "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.", "SERVER"],
    ["bedrock", "The system encountered an unexpected error during processing. Try your request again.", "SERVER"],
  ];

  it.each(PUBLISHED)("%s: %s -> %s", (_provider, message, expected) => {
    expect(classifyError(message).class).toBe(expected);
  });
});

describe("rule ordering", () => {
  it("reads a spent quota as QUOTA even though it is also a 429", () => {
    // Getting this backwards makes a worker wait for a window that never opens.
    const message = '429: {"message":"You exceeded your current quota","code":"insufficient_quota"}';
    expect(classifyError(message).class).toBe("QUOTA");
  });

  it("reads a spent quota as QUOTA even when pi reports the provider's retry delay", () => {
    const message = "Server requested 86400s retry delay (max: 60s). 429 You exceeded your current quota";
    expect(classifyError(message).class).toBe("QUOTA");
  });

  it("still reads plain throttling as RATE_LIMIT", () => {
    expect(classifyError('429: {"code":"rate_limit_exceeded"}').class).toBe("RATE_LIMIT");
  });

  it("lets a cause named in the message outrank a bare invitation to retry", () => {
    expect(classifyError("Request timed out. Please retry your request.").class).toBe("TIMEOUT");
    expect(classifyError("Connection error. You can retry your request.").class).toBe("TRANSPORT");
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
