import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Pictures of the page prototypes, taken by the installation rather than by a
 * model.
 *
 * A person confirming an interface looks at screens, not at HTML, and the pi
 * session that wrote the prototype is the last thing that should be trusted to
 * say what it looks like. These run off the files on disk in a headless
 * Chromium: no application, no network, no session -- a prototype that only
 * renders when a server is up is not a prototype.
 */
export interface PrototypeView {
  /** Stable name; part of the file name, so it is also what a person reads. */
  name: string;
  width: number;
  height: number;
  colorScheme: "light" | "dark";
}

/** Desktop and phone, light and dark: the four a person is asked to confirm.
 * Two viewports because a page that only works on one is the failure that
 * reaches a person last, and both schemes because a token table that forgot
 * dark mode looks finished until someone opens it at night. */
export const PROTOTYPE_VIEWS: readonly PrototypeView[] = [
  { name: "desktop-light", width: 1440, height: 900, colorScheme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, colorScheme: "dark" },
  { name: "mobile-light", width: 390, height: 844, colorScheme: "light" },
  { name: "mobile-dark", width: 390, height: 844, colorScheme: "dark" },
];

export interface PrototypeShotRequest {
  /** The contract root inside the worktree. */
  root: string;
  /** Page files relative to the root, as the contract lists them. */
  pages: readonly string[];
  outputDir: string;
  views?: readonly PrototypeView[];
  timeoutMs?: number;
  /** Overridden by tests; defaults to the Playwright CLI this build ships. */
  run?: (argv: readonly string[], timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
}

export interface PrototypeShot {
  page: string;
  view: string;
  path: string;
}

export interface PrototypeShotResult {
  shots: PrototypeShot[];
  /** One line per page-and-view that produced no picture. Never thrown: a
   * prototype that will not render is something a person has to be told about,
   * not a crash in the middle of a requirement. */
  failures: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The Playwright CLI from this installation's own dependencies. The target
 * repository may not have Playwright at all, and a prototype must not need it
 * to be photographed. Resolved through the package's manifest because its
 * `exports` map does not name the CLI entry point. */
export function playwrightCli(): string {
  return join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
}

async function runPlaywright(argv: readonly string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return await new Promise((settle) => {
    const child = spawn(process.execPath, [playwrightCli(), ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (cause) => { clearTimeout(timer); settle({ ok: false, output: cause.message }); });
    child.on("close", (code) => { clearTimeout(timer); settle({ ok: code === 0, output }); });
  });
}

/** `pages/board.html` becomes `board`, so a shot is named after the page a
 * person is looking at rather than after a path. */
export function pageSlug(page: string): string {
  return page.replace(/^.*\//, "").replace(/\.html$/i, "");
}

export async function capturePrototypePages(request: PrototypeShotRequest): Promise<PrototypeShotResult> {
  const views = request.views ?? PROTOTYPE_VIEWS;
  const run = request.run ?? runPlaywright;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await mkdir(request.outputDir, { recursive: true });

  const shots: PrototypeShot[] = [];
  const failures: string[] = [];
  // Sorted and sequential: the evidence directory has to come out the same on
  // every host, and four headless Chromiums racing each other on one page buys
  // nothing here.
  for (const page of [...request.pages].toSorted()) {
    for (const view of views) {
      const path = join(request.outputDir, `${pageSlug(page)}-${view.name}.png`);
      const result = await run([
        "screenshot",
        "--browser", "chromium",
        "--full-page",
        "--viewport-size", `${view.width}, ${view.height}`,
        "--color-scheme", view.colorScheme,
        pathToFileURL(resolve(request.root, page)).href,
        path,
      ], timeoutMs);
      if (result.ok) shots.push({ page, view: view.name, path });
      else failures.push(`${page} at ${view.name}: ${result.output.trim().split("\n").at(-1) ?? "no output"}`);
    }
  }
  return { shots, failures };
}
