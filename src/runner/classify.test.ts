import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyError } from "./classify.js";
import { extractFailure } from "./failure.js";

const FIXTURES = join(process.cwd(), "fixtures/rpc-errors");
const failureOf = (name: string) =>
  extractFailure(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")).events)!.errorMessage;

describe("captured fixtures classify as expected", () => {
  const cases: Array<[string, string]> = [
    ["auth", "AUTH"],
    ["quota", "QUOTA"],
    ["rate_limit", "RATE_LIMIT"],
    ["invalid_request", "INVALID_REQUEST"],
    ["server", "SERVER"],
    ["transport", "TRANSPORT"],
    ["mid_stream_drop", "TRANSPORT"],
  ];

  for (const [fixture, expected] of cases) {
    it(`${fixture} -> ${expected}`, () => {
      expect(classifyError(failureOf(fixture)).class).toBe(expected);
    });
  }
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
