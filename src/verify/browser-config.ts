import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

export interface BrowserConfigInput {
  /** The same list the guard and the verdict validation use. */
  allowedHosts: readonly string[];
  /** Where snapshots, screenshots, traces and video land. */
  outputDir: string;
  headed?: boolean;
  /**
   * Chromium's own process sandbox. Leave it on; a host that cannot build the
   * sandbox (a container, or Ubuntu's user-namespace restriction) should be
   * fixed at the kernel first, and only then run without one.
   */
  chromiumSandbox?: boolean;
}

export interface PlaywrightCliConfig {
  browser: {
    browserName: "chromium";
    isolated: boolean;
    launchOptions: { headless: boolean; chromiumSandbox?: boolean };
  };
  outputDir: string;
  snapshot: { mode: "full" };
  network: { allowedOrigins: string[] };
}

/**
 * Playwright reads an entry as a URL glob: a wildcard port has to be written
 * out, and a leading dot in our allowlist means "this domain and anything
 * under it", which becomes a leading `*`.
 */
function originsFor(host: string): string[] {
  const pattern = host.startsWith(".") ? `*${host}` : host;
  return [`http://${pattern}:*`, `https://${pattern}:*`];
}

/**
 * The browser's own copy of the host allowlist.
 *
 * With `network.allowedOrigins` set, playwright-cli aborts every request the
 * list does not cover, inside the browser context. That is the second of the
 * three layers: the guard refuses the command, this refuses the request, and
 * verdict validation refuses the claim. A page loaded off local disk is the
 * guard's job — a file:// main frame is a navigation, not a request, so it
 * never reaches this one.
 */
export function buildPlaywrightCliConfig(input: BrowserConfigInput): PlaywrightCliConfig {
  if (input.allowedHosts.length === 0) {
    throw new Error("a browser run needs at least one allowed host; an empty list would abort every request");
  }
  return {
    browser: {
      browserName: "chromium",
      // No profile on disk: a run must not inherit a session an earlier card
      // left behind, and evidence has to come from a cold start.
      isolated: true,
      launchOptions: {
        headless: input.headed !== true,
        ...(input.chromiumSandbox === false ? { chromiumSandbox: false } : {}),
      },
    },
    outputDir: input.outputDir,
    snapshot: { mode: "full" },
    network: {
      allowedOrigins: [...new Set(input.allowedHosts.flatMap((host) => originsFor(host)))].toSorted(),
    },
  };
}

export const PLAYWRIGHT_CLI_CONFIG_PATH = join(".playwright", "cli.config.json");

/** Writes the config into a worktree and returns its absolute path. */
export async function writePlaywrightCliConfig(
  worktreePath: string,
  input: BrowserConfigInput,
): Promise<string> {
  const path = join(worktreePath, PLAYWRIGHT_CLI_CONFIG_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(buildPlaywrightCliConfig(input), null, 2)}\n`, "utf8");
  return path;
}

/**
 * The PATH a browser-driving session runs with. The CLI is hivemind's own
 * dependency, not the target repository's, so the verifier finds it here
 * rather than by installing anything into the worktree it must not change.
 */
export function browserLanePath(hivemindRoot: string, currentPath = process.env.PATH ?? ""): string {
  const bin = join(hivemindRoot, "node_modules", ".bin");
  return currentPath ? `${bin}${delimiter}${currentPath}` : bin;
}
