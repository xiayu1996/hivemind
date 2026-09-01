import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_FENCED_PATTERNS } from "../src/guard/danger-rules.js";
import { assembleGuardPolicy } from "../src/guard/policy.js";
import { decideToolCall } from "../src/guard/tool-decision.js";
import { writePlaywrightCliConfig } from "../src/verify/browser-config.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "node_modules", ".bin", "playwright-cli");
const SESSION = "hivemind-smoke";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hivemind smoke</title></head>
<body>
  <h1>delivery board</h1>
  <p id="waiting">one card is waiting for an answer</p>
  <img alt="offsite" src="https://example.com/tracker.png">
</body></html>`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(workspace: string, args: string[]): Promise<CliResult> {
  try {
    const result = await execFileAsync(CLI, [`-s=${SESSION}`, ...args], {
      cwd: workspace,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string; message: string };
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

function check(label: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!passed) process.exitCode = 1;
}

/**
 * Proves the two mechanised layers of the browser guard on a real browser:
 * the guard refuses the command, and the browser refuses the request. The
 * third layer, verdict validation, is exercised by the VERIFY unit tests.
 */
async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "hivemind-browser-smoke-"));
  const evidence = join(workspace, "evidence");
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("smoke server did not bind a port");
  const origin = `http://127.0.0.1:${address.port}`;

  const policy = assembleGuardPolicy({
    phase: "E2E",
    cardId: "S-SMOKE-01",
    runId: "smoke-browser",
    worktreePath: workspace,
    auditPath: join(evidence, "tool-audit.jsonl"),
    e2eHostAllowlist: ["127.0.0.1"],
  });
  const decide = (command: string) =>
    decideToolCall({ toolName: "bash", toolCallId: "tc", input: { command } }, policy, DEFAULT_FENCED_PATTERNS);

  try {
    await writePlaywrightCliConfig(workspace, { allowedHosts: ["127.0.0.1"], outputDir: evidence });

    check("guard allows the run against the allowlisted host",
      !decide(`playwright-cli goto ${origin}/`).block);
    const offsite = decide("playwright-cli goto https://example.com/");
    check("guard blocks a host that is not on the list", offsite.block, offsite.reason ?? "");
    const local = decide("playwright-cli open file:///tmp/dist/index.html");
    check("guard blocks a page loaded off the disk", local.block, local.reason ?? "");

    const opened = await cli(workspace, ["open", `${origin}/`]);
    check("browser opened the page", opened.code === 0, opened.stderr.trim().split("\n").at(-1) ?? "");

    const snapshot = await cli(workspace, ["snapshot"]);
    check("snapshot carries the page's own words",
      snapshot.stdout.includes("delivery board") && snapshot.stdout.includes("waiting for an answer"));

    // No filename: the configured outputDir is what puts evidence where the
    // card's evidence lives, without the agent having to know that path.
    const shot = await cli(workspace, ["screenshot"]);
    check("screenshot command succeeded", shot.code === 0, shot.stderr.trim().split("\n").at(-1) ?? "");

    const requests = await cli(workspace, ["requests"]);
    check("the offsite request was refused by the browser itself",
      /example\.com/.test(requests.stdout) && /abort|blocked|failed/i.test(requests.stdout),
      requests.stdout.split("\n").filter((line) => line.includes("example.com")).join(" | "));

    const escaped = await cli(workspace, ["goto", "https://example.com/"]);
    check("navigating off the allowlist fails in the browser", escaped.code !== 0,
      escaped.stderr.trim().split("\n").at(-1) ?? escaped.stdout.trim().split("\n").at(-1) ?? "");

    const files: string[] = [];
    for (const entry of await readdir(evidence, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
    }
    const png = files.find((file) => file.endsWith(".png"));
    const size = png ? (await stat(png)).size : 0;
    check("evidence landed in the card's evidence directory", size > 1_000,
      png ? `${png} (${size} bytes)` : `nothing under ${evidence}`);
  } finally {
    await cli(workspace, ["close"]);
    await new Promise<void>((settle) => server.close(() => settle()));
    console.log(`workspace kept for inspection: ${workspace}`);
  }
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${(error as Error).message}`);
  process.exit(1);
});
