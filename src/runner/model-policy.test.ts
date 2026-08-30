import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../config/store.js";
import { migrate } from "../persistence/migrate.js";
import { ModelPolicy, assertModelPolicy } from "./model-policy.js";

const catalog = {
  list: async (provider: string) => ({
    "openai-codex": [
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "openai-codex", id: "gpt-5.6-terra" },
      { provider: "openai-codex", id: "gpt-5.4-mini" },
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
    await expect(policy.resolve("completion_judge", "openai-codex")).resolves.toMatchObject({ id: "gpt-5.4-mini" });
  });

  it("refuses a purpose the provider declares no model for, instead of guessing one", async () => {
    const policy = new ModelPolicy(config, catalog);
    await expect(policy.resolve("design", "zai-coding-cn")).rejects.toThrow(/zai-coding-cn.*brain/);
  });

  it("refuses a configured id the provider catalogue does not list", async () => {
    await config.set("model.tierMap", {
      brain: { "openai-codex": "gpt-5.6-imaginary" },
      standard: { "openai-codex": "gpt-5.6-terra" },
      cheap: { "openai-codex": "gpt-5.4-mini" },
    }, "test");
    const policy = new ModelPolicy(config, catalog);
    await expect(policy.resolve("design", "openai-codex")).rejects.toThrow(/catalogue/);
  });

  it("walks the failover chain and reports every provider that can serve a purpose", async () => {
    await config.set("model.tierMap", {
      brain: { "openai-codex": "gpt-5.6-sol" },
      standard: { "openai-codex": "gpt-5.6-terra", "zai-coding-cn": "glm-5" },
      cheap: { "openai-codex": "gpt-5.4-mini", "zai-coding-cn": "glm-5" },
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
      decompose: "brain", design: "cheap", code: "standard", verify: "standard", merge: "standard",
      completion_judge: "cheap", capacity_probe: "cheap", triage: "cheap", distiller: "cheap",
    }, "test");
    const policy = new ModelPolicy(config, catalog);
    await expect(policy.resolve("design", "openai-codex")).resolves.toMatchObject({ id: "gpt-5.4-mini" });
  });

  it("rejects the whole policy at startup when any configured id is not in its catalogue", async () => {
    await expect(assertModelPolicy(config, catalog)).resolves.toBeUndefined();
    await config.set("model.tierMap", {
      brain: { "openai-codex": "gpt-5.6-sol" },
      standard: { "openai-codex": "typo-model" },
      cheap: { "openai-codex": "gpt-5.4-mini" },
    }, "test");
    await expect(assertModelPolicy(config, catalog)).rejects.toThrow(/typo-model/);
  });
});
