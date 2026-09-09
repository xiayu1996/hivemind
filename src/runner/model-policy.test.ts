import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { ModelPolicy, assertModelPolicy } from "./model-policy.js";

const catalog = {
  list: async (provider: string) => ({
    "openai-codex": [
      { provider: "openai-codex", id: "gpt-5.6-sol", thinking: true },
      { provider: "openai-codex", id: "gpt-5.6-terra", thinking: true },
      { provider: "openai-codex", id: "gpt-5.6-luna", thinking: false },
    ],
    "zai-coding-cn": [{ provider: "zai-coding-cn", id: "glm-5" }],
  }[provider] ?? []),
};

describe("ModelPolicy", () => {
  let client: ReturnType<typeof createClient>;
  let config: ConfigStore;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    config = await ConfigStore.load(client);
  });

  it("maps a purpose to its tier and then to the provider's model for that tier", async () => {
    const policy = new ModelPolicy(config, catalog);
    await expect(policy.resolve("design", "openai-codex")).resolves.toMatchObject({ provider: "openai-codex", id: "gpt-5.6-sol" });
    await expect(policy.resolve("code", "openai-codex")).resolves.toMatchObject({ id: "gpt-5.6-terra" });
    await expect(policy.resolve("triage", "openai-codex")).resolves.toMatchObject({ id: "gpt-5.6-luna" });
  });

  it("refuses a purpose the provider declares no model for, instead of guessing one", async () => {
    const policy = new ModelPolicy(config, catalog);
    await expect(policy.resolve("design", "zai-coding-cn")).rejects.toThrow(/zai-coding-cn.*brain/);
  });

  it("refuses at write time an id the recorded catalogue does not advertise", async () => {
    // The recording makes this check synchronous, so the console rejects the
    // change instead of storing a policy no card can ever spawn.
    await expect(config.set("model.providers", {
      "openai-codex": {
        authType: "oauth",
        tiers: { brain: "gpt-5.6-imaginary", standard: "gpt-5.6-terra", cheap: "gpt-5.6-luna" },
      },
    }, "test")).rejects.toThrow(/does not advertise/);
  });

  it("refuses at resolve time an id no recording could have vetted", async () => {
    // zai-coding-cn has no recorded catalogue, so the schema lets it through and
    // the live catalogue is the only thing standing between it and a spawn.
    await config.set("model.providers", {
      "zai-coding-cn": { authType: "api_key", envKey: "ZAI_CODING_CN_API_KEY", tiers: { brain: "glm-6" } },
    }, "test");
    const policy = new ModelPolicy(config, catalog);
    await expect(policy.resolve("design", "zai-coding-cn")).rejects.toThrow(/catalogue/);
  });

  it("walks the failover chain and reports every provider that can serve a purpose", async () => {
    await config.set("model.providers", {
      "openai-codex": {
        authType: "oauth",
        tiers: { brain: "gpt-5.6-sol", standard: "gpt-5.6-terra", cheap: "gpt-5.6-luna" },
      },
      "zai-coding-cn": { authType: "api_key", envKey: "ZAI_CODING_CN_API_KEY", tiers: { standard: "glm-5", cheap: "glm-5" } },
    }, "test");
    await config.set("model.failoverChain", ["openai-codex", "zai-coding-cn"], "test");
    const policy = new ModelPolicy(config, catalog);

    await expect(policy.providersFor("code")).resolves.toEqual(["openai-codex", "zai-coding-cn"]);
    await expect(policy.providersFor("design")).resolves.toEqual(["openai-codex"]);
  });

  it("reads the tier of a purpose from config rather than from a built-in table", async () => {
    // The key is exhaustive on purpose: an overlay replaces the whole value, so
    // a partial map would silently leave a call site with no tier at all.
    await config.set("model.purposeTiers", {
      product_manager: "brain", decompose: "brain", design: "cheap", code: "standard",
      verify: "standard", merge: "standard", capacity_probe: "cheap",
      triage: "cheap", distiller: "cheap",
    }, "test");
    const policy = new ModelPolicy(config, catalog);
    await expect(policy.resolve("design", "openai-codex")).resolves.toMatchObject({ id: "gpt-5.6-luna" });
  });

  it("rejects the whole policy at startup when any configured id is not in its catalogue", async () => {
    await expect(assertModelPolicy(config, catalog)).resolves.toBeUndefined();
    await config.set("model.providers", {
      "zai-coding-cn": { authType: "api_key", envKey: "ZAI_CODING_CN_API_KEY", tiers: { standard: "typo-model" } },
    }, "test");
    await expect(assertModelPolicy(config, catalog)).rejects.toThrow(/typo-model/);
  });

  it("attaches the purpose's reasoning effort only to a model that advertises thinking", async () => {
    const policy = new ModelPolicy(config, catalog);
    // design is a brain-tier purpose and gpt-5.6-sol reasons, so the level rides along.
    await expect(policy.resolve("design", "openai-codex")).resolves.toMatchObject({ thinkingLevel: "high" });
    // triage lands on a model whose catalogue row says it does not reason: pi
    // would accept the argument and do nothing useful with it, so none is sent.
    await expect(policy.resolve("triage", "openai-codex")).resolves.not.toHaveProperty("thinkingLevel");
  });

  it("passes a changed effort through without touching the tier", async () => {
    await config.set("model.purposeThinking", {
      product_manager: "high", decompose: "high", design: "minimal", code: "medium",
      verify: "medium", merge: "low", capacity_probe: "off", triage: "low", distiller: "off",
    }, "test");
    const policy = new ModelPolicy(config, catalog);
    await expect(policy.resolve("design", "openai-codex")).resolves.toMatchObject({
      id: "gpt-5.6-sol",
      thinkingLevel: "minimal",
    });
  });
});
