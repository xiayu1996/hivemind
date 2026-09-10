import { describe, expect, it } from "vitest";
import { MissingProviderKeyError, defaultApiKeyEnvVar, isMeteredProvider, needsApiKeyEnv, providerKeyEnv } from "./provider-env.js";

const SECRETS_PATH = "/home/agent/.hivemind/secrets.env";

describe("defaultApiKeyEnvVar", () => {
  it("follows pi's naming for a plain provider name", () => {
    expect(defaultApiKeyEnvVar("deepseek")).toBe("DEEPSEEK_API_KEY");
  });

  it("folds separators, so a hyphenated provider still names a legal variable", () => {
    expect(defaultApiKeyEnvVar("openai-codex")).toBe("OPENAI_CODEX_API_KEY");
  });
});

describe("providerKeyEnv", () => {
  it("reads the key from the secrets file nothing else hands to a manual command", () => {
    const secrets = new Map([["DEEPSEEK_API_KEY", "from-file"], ["NOTION_TOKEN", "unrelated"]]);
    expect(providerKeyEnv({ provider: "deepseek", secrets, secretsPath: SECRETS_PATH, env: {} }))
      .toEqual({ DEEPSEEK_API_KEY: "from-file" });
  });

  it("passes on that one variable only, never the rest of the file", () => {
    const secrets = new Map([["DEEPSEEK_API_KEY", "k"], ["NOTION_TOKEN", "unrelated"]]);
    const passed = providerKeyEnv({ provider: "deepseek", secrets, secretsPath: SECRETS_PATH, env: {} });
    expect(Object.keys(passed)).toEqual(["DEEPSEEK_API_KEY"]);
  });

  it("lets an exported value win, so a canary host can override the file", () => {
    const secrets = new Map([["DEEPSEEK_API_KEY", "from-file"]]);
    expect(providerKeyEnv({
      provider: "deepseek", secrets, secretsPath: SECRETS_PATH, env: { DEEPSEEK_API_KEY: "exported" },
    })).toEqual({ DEEPSEEK_API_KEY: "exported" });
  });

  it("honours a profile that names a variable pi's convention would get wrong", () => {
    const secrets = new Map([["ZAI_TOKEN", "k"]]);
    expect(providerKeyEnv({ provider: "zai", envKey: "ZAI_TOKEN", secrets, secretsPath: SECRETS_PATH, env: {} }))
      .toEqual({ ZAI_TOKEN: "k" });
  });

  it("names the variable and the file it looked in, rather than blaming the credential", () => {
    // The old failure said "configure this provider's credentials", which sent
    // an operator to re-add a key that was already there.
    expect(() => providerKeyEnv({ provider: "deepseek", secrets: new Map(), secretsPath: SECRETS_PATH, env: {} }))
      .toThrow(MissingProviderKeyError);
    expect(() => providerKeyEnv({ provider: "deepseek", secrets: new Map(), secretsPath: SECRETS_PATH, env: {} }))
      .toThrow(/DEEPSEEK_API_KEY.*secrets\.env/);
  });
});

describe("needsApiKeyEnv", () => {
  it("is false for oauth, whose credential lives in pi's auth file", () => {
    expect(needsApiKeyEnv({ authType: "oauth" })).toBe(false);
    expect(needsApiKeyEnv({ authType: "api_key" })).toBe(true);
  });
});

describe("isMeteredProvider", () => {
  it("follows the profile when it declares its billing", () => {
    expect(isMeteredProvider({ authType: "oauth", billing: "metered" })).toBe(true);
    expect(isMeteredProvider({ authType: "api_key", billing: "subscription" })).toBe(false);
  });

  it("falls back to the credential kind, which is right for both providers configured today", () => {
    expect(isMeteredProvider({ authType: "api_key" })).toBe(true);
    expect(isMeteredProvider({ authType: "oauth" })).toBe(false);
  });
});
