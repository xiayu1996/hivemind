import { delimiter, join } from "node:path";

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
 * The browser's own copy of the host allowlist, carried in the environment.
 *
 * With `network.allowedOrigins` set, playwright-cli aborts every request the
 * list does not cover, inside the browser context. That is the second of the
 * three layers: the guard refuses the command, this refuses the request, and
 * verdict validation refuses the claim. A page loaded off local disk is the
 * guard's job -- a file:// main frame is a navigation, not a request, so it
 * never reaches this one.
 *
 * It is the environment rather than `<worktree>/.playwright/cli.config.json`
 * for two reasons. Writing that file changes the tree the verifier is pinned
 * against, so every browser round would be quarantined as a forgery; and a
 * target repository may ship a config of its own, which the CLI reads before
 * the environment and would otherwise use to widen the allowlist.
 */
export function browserLaneEnv(input: BrowserConfigInput): Record<string, string> {
  if (input.allowedHosts.length === 0) {
    throw new Error("a browser run needs at least one allowed host; an empty list would abort every request");
  }
  return {
    PLAYWRIGHT_MCP_ALLOWED_ORIGINS: [...new Set(input.allowedHosts.flatMap((host) => originsFor(host)))]
      .toSorted()
      .join(";"),
    PLAYWRIGHT_MCP_OUTPUT_DIR: input.outputDir,
    // No profile on disk: a run must not inherit a session an earlier card
    // left behind, and evidence has to come from a cold start.
    PLAYWRIGHT_MCP_ISOLATED: "true",
    PLAYWRIGHT_MCP_HEADLESS: input.headed === true ? "false" : "true",
    ...(input.chromiumSandbox === false ? { PLAYWRIGHT_MCP_SANDBOX: "false" } : {}),
  };
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
