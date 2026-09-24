import { describe, expect, it } from "vitest";
import { ConfigStore } from "../config/store.js";
import { CACHE_RETENTION_ENV, cacheRetentionEnv } from "./cache-retention.js";

describe("cacheRetentionEnv", () => {
  it("asks for the long window by default", () => {
    expect(cacheRetentionEnv(ConfigStore.defaults())).toEqual({ [CACHE_RETENTION_ENV]: "long" });
  });
});
