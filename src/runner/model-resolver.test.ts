import { describe, expect, it } from "vitest";
import {
  cachingCatalog,
  firstNonEmptyCatalog,
  parseModelTable,
  parseTokenCount,
  resolveModel,
  staticCatalog,
  type ModelCatalog,
} from "./model-resolver.js";

const TABLE = [
  "provider  model         context  max-out  thinking  images",
  "mock      mock-1        128K     4.1K     no        no",
  "mock      mock-1-large  1M       384K     yes       yes",
].join("\n");

describe("model resolution", () => {
  it("parses the pi model table and resolves only an exact provider/id pair", async () => {
    const models = parseModelTable(TABLE);
    await expect(resolveModel({ list: async () => models }, "mock", "mock-1")).resolves.toMatchObject({
      provider: "mock",
      id: "mock-1",
    });
    await expect(resolveModel({ list: async () => models }, "mock", "mock")).rejects.toThrow(/not present/);
  });

  it("does not resolve a model advertised by another provider", async () => {
    await expect(resolveModel({
      list: async () => [{ provider: "other", id: "same-name" }],
    }, "mock", "same-name")).rejects.toThrow(/not present/);
  });

  it("carries the catalogue's capabilities onto the resolved model", async () => {
    const models = parseModelTable(TABLE);
    await expect(resolveModel({ list: async () => models }, "mock", "mock-1-large")).resolves.toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 384_000,
      thinking: true,
      images: true,
    });
  });
});

describe("model table columns", () => {
  it("reads the token counts pi prints", () => {
    expect(parseTokenCount("128K")).toBe(128_000);
    expect(parseTokenCount("4.1K")).toBe(4_100);
    expect(parseTokenCount("1M")).toBe(1_000_000);
    expect(parseTokenCount("272000")).toBe(272_000);
    expect(parseTokenCount("-")).toBeUndefined();
  });

  it("keeps a row whose later columns are missing", () => {
    expect(parseModelTable(["provider  model", "mock      mock-1"].join("\n"))).toEqual([
      { provider: "mock", id: "mock-1" },
    ]);
  });

  it("reports nothing when pi printed no table", () => {
    expect(parseModelTable('No models matching "deepseek"')).toEqual([]);
  });
});

describe("catalogue composition", () => {
  it("lists a provider once however many models are resolved from it", async () => {
    let calls = 0;
    const counted: ModelCatalog = {
      list: async (provider) => {
        calls += 1;
        return [{ provider, id: "mock-1" }];
      },
    };
    const catalog = cachingCatalog(counted);
    await resolveModel(catalog, "mock", "mock-1");
    await resolveModel(catalog, "mock", "mock-1");
    expect(calls).toBe(1);
  });

  it("does not cache a failed listing", async () => {
    let calls = 0;
    const flaky: ModelCatalog = {
      list: async (provider) => {
        calls += 1;
        if (calls === 1) throw new Error("pi is not installed");
        return [{ provider, id: "mock-1" }];
      },
    };
    const catalog = cachingCatalog(flaky);
    await expect(catalog.list("mock")).rejects.toThrow(/not installed/);
    await expect(catalog.list("mock")).resolves.toHaveLength(1);
  });

  it("falls back to the next catalogue when the first knows nothing of the provider", async () => {
    const live = staticCatalog([{ provider: "openai-codex", id: "gpt-5.4-mini" }]);
    const recorded = staticCatalog([{ provider: "deepseek", id: "deepseek-v4-pro", contextWindow: 1_000_000 }]);
    const catalog = firstNonEmptyCatalog(live, recorded);
    await expect(catalog.list("deepseek")).resolves.toMatchObject([{ id: "deepseek-v4-pro" }]);
    await expect(catalog.list("openai-codex")).resolves.toMatchObject([{ id: "gpt-5.4-mini" }]);
  });

  it("falls back when the first catalogue throws rather than answering empty", async () => {
    const broken: ModelCatalog = { list: async () => { throw new Error("pi is not installed"); } };
    const recorded = staticCatalog([{ provider: "deepseek", id: "deepseek-v4-pro" }]);
    await expect(firstNonEmptyCatalog(broken, recorded).list("deepseek")).resolves.toHaveLength(1);
  });
});
