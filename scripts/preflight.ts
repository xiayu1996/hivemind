import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { alertChannelsFromConfig } from "../src/alert/config.js";
import { AlertRouter } from "../src/alert/index.js";
import { assertOutOfBandChannel } from "../src/alert/required-channel.js";
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { ConfigStore } from "../src/config/store.js";
import { NotionGateway, NotionGatewayError } from "../src/notion/gateway.js";
import { createNotionHttpTransport } from "../src/notion/sdk-adapters.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { probeProviderReadiness } from "../src/runner/auth-probe.js";
import { assertProviderRetriesDisabled } from "../src/runner/failover.js";
import { assertModelPolicy, ModelPolicy } from "../src/runner/model-policy.js";
import { PiModelCatalog } from "../src/runner/model-resolver.js";
import { defaultPiBinary, pinnedPiVersion } from "../src/runner/pi-binary.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PI_VERSION = pinnedPiVersion();

type Verdict = "PASS" | "FAIL" | "WARN";

interface Finding {
  verdict: Verdict;
  check: string;
  detail: string;
}

const findings: Finding[] = [];

function record(verdict: Verdict, check: string, detail = ""): void {
  findings.push({ verdict, check, detail });
  console.log(`${verdict} ${check}${detail ? ` — ${detail}` : ""}`);
}

async function attempt(check: string, run: () => Promise<string | void>, failure: Verdict = "FAIL"): Promise<void> {
  try {
    const detail = await run();
    record("PASS", check, detail ?? "");
  } catch (error) {
    record(failure, check, (error as Error).message);
  }
}

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function output(binary: string, args: string[], cwd?: string): Promise<string> {
  return (await execFileAsync(binary, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

/**
 * Answers one question before a host is trusted with cards: can this machine
 * take a requirement from the board to a merged review request on its own?
 * Every check names what is missing in words a person can act on; no check
 * ever prints a credential.
 */
async function main(): Promise<void> {
  const secretsPath = join(homedir(), ".hivemind", "secrets.env");
  const piBinary = defaultPiBinary();
  const repositoryPath = resolve(optional("--repository-path") ?? ROOT);

  await attempt("Node.js 26 or newer", async () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 26) throw new Error(`running ${process.versions.node}`);
    return process.versions.node;
  });

  await attempt(`pi ${PI_VERSION} installed`, async () => {
    const version = await output(piBinary, ["--version"]);
    if (version !== PI_VERSION) throw new Error(`found ${version} at ${piBinary}`);
    return piBinary;
  });

  const stored = await loadSecretsFile().catch(() => new Map<string, string>());
  await attempt("secrets file present and private", async () => {
    const info = await stat(secretsPath);
    const mode = info.mode & 0o777;
    if (process.platform !== "win32" && mode !== 0o600) {
      throw new Error(`${secretsPath} has mode ${mode.toString(8)}, expected 600`);
    }
  });
  for (const key of [
    "NOTION_TOKEN",
    "HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID",
    "HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID",
    "HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID",
    "NOTION_BOT_USER_ID",
  ]) {
    await attempt(`${key} configured`, async () => {
      if (!(process.env[key] ?? stored.get(key))) {
        throw new Error(key === "NOTION_TOKEN"
          ? `missing from ${secretsPath}`
          : `missing; run scripts/notion-bootstrap.ts to create the board and store its ids`);
      }
    });
  }

  const token = process.env.NOTION_TOKEN ?? stored.get("NOTION_TOKEN");
  if (token) {
    const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token }) });
    await attempt("Notion integration reachable", async () => {
      const me = await gateway.request({ method: "GET", path: "/v1/users/me", priority: "projection" });
      const name = (me.data as { name?: string }).name;
      return name ? `integration "${name}"` : "";
    });
    for (const [label, key] of [
      ["Stories", "HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID"],
      ["Epics", "HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID"],
      ["Requirements", "HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID"],
    ] as const) {
      const id = process.env[key] ?? stored.get(key);
      if (!id) continue;
      await attempt(`${label} database shared with the integration`, async () => {
        try {
          await gateway.request({ method: "GET", path: `/v1/data_sources/${encodeURIComponent(id)}`, priority: "projection" });
        } catch (error) {
          if (error instanceof NotionGatewayError && error.status === 404) {
            throw new Error("Notion returns 404: the database is not shared with the integration, or the id is stale", { cause: error });
          }
          throw error;
        }
      });
    }
  }

  const dbUrl = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
  const handle = openDb(dbUrl);
  let config: ConfigStore | undefined;
  await attempt("central database opens and migrates", async () => {
    await migrate(handle.client);
    config = await ConfigStore.load(handle.client);
    return dbUrl;
  });

  if (config) {
    const catalog = new PiModelCatalog({ binary: piBinary });
    await attempt("every configured model id exists in its provider's catalogue", () => assertModelPolicy(config!, catalog));
    await attempt("provider retries are disabled (failover owns retries)", () => assertProviderRetriesDisabled(config!));
    await attempt("an out-of-band alert channel is configured", () =>
      assertOutOfBandChannel(new AlertRouter(alertChannelsFromConfig(stored)), config!, (message) => {
        throw new Error(message);
      }), "WARN");

    const policy = new ModelPolicy(config, catalog);
    const chain = config.get("model.failoverChain");
    for (const provider of chain) {
      await attempt(`provider ${provider} credentials ready`, async () => {
        const readiness = await probeProviderReadiness(piBinary, provider);
        if (!readiness.ready) throw new Error(readiness.reason ?? "not ready; run scripts/pi-login.sh");
      }, chain.length > 1 ? "WARN" : "FAIL");
    }
    for (const purpose of ["product_manager", "decompose", "code", "verify"] as const) {
      await attempt(`a provider serves the ${purpose} tier`, async () => {
        const providers = await policy.providersFor(purpose);
        if (providers.length === 0) throw new Error("no provider in the failover chain declares a model for this tier");
        return providers.join(", ");
      });
    }
  }

  await attempt("a review-request CLI is installed and signed in", async () => {
    for (const [binary, args] of [["gh", ["auth", "status"]], ["glab", ["auth", "status"]]] as const) {
      try {
        await output(binary, [...args]);
        return binary;
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        throw new Error(`${binary} is installed but not signed in; run ${binary} auth login`, { cause: error });
      }
    }
    throw new Error("neither gh nor glab is installed");
  });

  await attempt("git identity configured", async () => {
    const name = await output("git", ["config", "user.name"]).catch(() => "");
    const email = await output("git", ["config", "user.email"]).catch(() => "");
    if (!name || !email) throw new Error("git config user.name / user.email are empty");
    return name;
  });

  await attempt("repository checkout has an origin", async () => {
    const remote = await output("git", ["remote", "get-url", "origin"], repositoryPath);
    return `${repositoryPath} -> ${remote}`;
  });

  if (process.platform === "linux") {
    await attempt("systemd runs as PID 1 (needed for the service units)", async () => {
      const comm = await readFile("/proc/1/comm", "utf8").then((value) => value.trim(), () => "");
      if (comm !== "systemd") {
        const wsl = await readFile("/proc/version", "utf8").then((value) => /microsoft/i.test(value), () => false);
        throw new Error(wsl
          ? "WSL runs without systemd; add [boot] systemd=true to /etc/wsl.conf and run wsl --shutdown"
          : `PID 1 is ${comm || "unknown"}`);
      }
    }, "WARN");
    await attempt("kernel lets Chromium build its sandbox", async () => {
      const restricted = await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8")
        .then((value) => value.trim() === "1", () => false);
      if (restricted) {
        throw new Error("AppArmor restricts unprivileged user namespaces; run sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 (see docs/runbooks/linux-single-node.md)");
      }
    });
  }

  await attempt("headless Chromium for the browser lane", async () => {
    const cli = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "playwright-cli.cmd" : "playwright-cli");
    const wanted = JSON.parse(await readFile(join(ROOT, "node_modules", "playwright", "package.json"), "utf8")) as { version: string };
    const listing = await output(cli, ["install-browser", "--list"]);
    const section = listing.split("Playwright version:").find((part) => part.trim().startsWith(wanted.version));
    if (!section) throw new Error(`no browsers installed for playwright ${wanted.version}`);
    if (!/chromium_headless_shell-\d+/.test(section)) {
      throw new Error("chromium headless shell missing; run npx playwright-cli install-browser chromium --only-shell --with-deps");
    }
    return /chromium_headless_shell-\d+/.exec(section)![0];
  });

  handle.close();

  const failed = findings.filter((finding) => finding.verdict === "FAIL").length;
  const warned = findings.filter((finding) => finding.verdict === "WARN").length;
  console.log(`\n${failed === 0 ? "READY" : "NOT READY"}: ${findings.length - failed - warned} passed, ${warned} warnings, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${(error as Error).message}`);
  process.exit(1);
});
