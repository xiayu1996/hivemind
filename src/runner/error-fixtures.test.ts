import { describe, expect, it } from "vitest";
import {
  assertErrorFixtureCoverage,
  capturedFailures,
  capturedProviders,
  REQUIRED_ERROR_CLASSES,
} from "./error-fixtures.js";

const providers = capturedProviders();

describe("captured provider failures", () => {
  it("has captured at least one provider", () => {
    expect(providers.length).toBeGreaterThan(0);
  });

  it.each(providers)("%s: every capture is recognised rather than read as UNKNOWN", (provider) => {
    const unknown = capturedFailures(provider).filter((failure) => failure.class === "UNKNOWN");
    expect(unknown.map((failure) => failure.fixture)).toEqual([]);
  });

  it.each(providers)("%s: covers the classes a recovery path depends on", (provider) => {
    const covered = new Set(capturedFailures(provider).map((failure) => failure.class));
    expect(REQUIRED_ERROR_CLASSES.filter((required) => !covered.has(required))).toEqual([]);
  });
});

describe("the coverage gate", () => {
  it("passes a provider whose failures have been captured", () => {
    expect(() => assertErrorFixtureCoverage(["openai-codex"])).not.toThrow();
  });

  it("refuses a provider added to the chain before its failures were captured", () => {
    // Adding a provider is a configuration change; without this it is enough to
    // get a card assigned to one whose quota wording nothing has ever read.
    expect(() => assertErrorFixtureCoverage(["openai-codex", "deepseek"]))
      .toThrow(/deepseek: AUTH, QUOTA, RATE_LIMIT/);
  });
});
