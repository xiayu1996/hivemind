import { describe, expect, it } from "vitest";
import { browserLaneEnv } from "./browser-config.js";

describe("browserLaneEnv", () => {
  it("turns the host allowlist into origins the browser can match, ports included", () => {
    const env = browserLaneEnv({
      allowedHosts: ["localhost", "127.0.0.1"],
      outputDir: "/ev/card-12/browser",
    });
    expect(env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS).toBe(
      "http://127.0.0.1:*;http://localhost:*;https://127.0.0.1:*;https://localhost:*",
    );
  });

  it("reads a leading dot as a domain and everything under it", () => {
    const env = browserLaneEnv({
      allowedHosts: [".staging.example"],
      outputDir: "/ev/card-12/browser",
    });
    expect(env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS).toBe("http://*.staging.example:*;https://*.staging.example:*");
  });

  it("keeps Chromium's sandbox unless a host is explicitly configured without one", () => {
    const base = { allowedHosts: ["localhost"], outputDir: "/ev/card-12/browser" };
    expect(browserLaneEnv(base).PLAYWRIGHT_MCP_SANDBOX).toBeUndefined();
    expect(browserLaneEnv({ ...base, chromiumSandbox: true }).PLAYWRIGHT_MCP_SANDBOX).toBeUndefined();
    expect(browserLaneEnv({ ...base, chromiumSandbox: false }).PLAYWRIGHT_MCP_SANDBOX).toBe("false");
  });

  it("starts cold and headless, and puts the evidence where the card's evidence lives", () => {
    const env = browserLaneEnv({ allowedHosts: ["localhost"], outputDir: "/ev/card-12/browser" });
    expect(env.PLAYWRIGHT_MCP_ISOLATED).toBe("true");
    expect(env.PLAYWRIGHT_MCP_HEADLESS).toBe("true");
    expect(env.PLAYWRIGHT_MCP_OUTPUT_DIR).toBe("/ev/card-12/browser");
  });

  it("names no file in the worktree, so a browser round cannot change the tree it verifies", () => {
    const env = browserLaneEnv({ allowedHosts: ["localhost"], outputDir: "/ev/card-12/browser" });
    expect(Object.values(env).some((value) => value.includes(".playwright"))).toBe(false);
  });

  it("refuses an empty allowlist rather than configuring a browser that aborts everything", () => {
    expect(() => browserLaneEnv({ allowedHosts: [], outputDir: "/ev" }))
      .toThrow(/at least one allowed host/);
  });
});
