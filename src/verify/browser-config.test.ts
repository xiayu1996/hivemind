import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAYWRIGHT_CLI_CONFIG_PATH,
  buildPlaywrightCliConfig,
  writePlaywrightCliConfig,
} from "./browser-config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("buildPlaywrightCliConfig", () => {
  it("turns the host allowlist into origins the browser can match, ports included", () => {
    const config = buildPlaywrightCliConfig({
      allowedHosts: ["localhost", "127.0.0.1"],
      outputDir: "/ev/card-12/browser",
    });
    expect(config.network.allowedOrigins).toEqual([
      "http://127.0.0.1:*",
      "http://localhost:*",
      "https://127.0.0.1:*",
      "https://localhost:*",
    ]);
  });

  it("reads a leading dot as a domain and everything under it", () => {
    const config = buildPlaywrightCliConfig({
      allowedHosts: [".staging.example"],
      outputDir: "/ev/card-12/browser",
    });
    expect(config.network.allowedOrigins).toEqual([
      "http://*.staging.example:*",
      "https://*.staging.example:*",
    ]);
  });

  it("starts cold and headless, and puts the evidence where the card's evidence lives", () => {
    const config = buildPlaywrightCliConfig({
      allowedHosts: ["localhost"],
      outputDir: "/ev/card-12/browser",
    });
    expect(config.browser).toEqual({
      browserName: "chromium",
      isolated: true,
      launchOptions: { headless: true },
    });
    expect(config.outputDir).toBe("/ev/card-12/browser");
  });

  it("refuses an empty allowlist rather than writing a config that aborts everything", () => {
    expect(() => buildPlaywrightCliConfig({ allowedHosts: [], outputDir: "/ev" }))
      .toThrow(/at least one allowed host/);
  });
});

describe("writePlaywrightCliConfig", () => {
  it("writes where playwright-cli looks by default", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "hivemind-worktree-"));
    tempDirs.push(worktree);

    const path = await writePlaywrightCliConfig(worktree, {
      allowedHosts: ["localhost"],
      outputDir: join(worktree, "evidence"),
    });

    expect(path).toBe(join(worktree, PLAYWRIGHT_CLI_CONFIG_PATH));
    const written = JSON.parse(readFileSync(path, "utf8")) as { network: { allowedOrigins: string[] } };
    expect(written.network.allowedOrigins).toContain("http://localhost:*");
  });
});
