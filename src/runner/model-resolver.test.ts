import { describe, expect, it } from "vitest";
import { parseModelTable, resolveModel } from "./model-resolver.js";

describe("model resolution", () => {
  it("parses the pi model table and resolves only an exact provider/id pair", async () => {
    const models = parseModelTable([
      "provider  model         context  max-out  thinking  images",
      "mock      mock-1        128K     4.1K     no        no",
      "mock      mock-1-large  128K     4.1K     yes       no",
    ].join("\n"));
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
});
