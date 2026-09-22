import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
import { assertSchemaCurrent, schemaFingerprint } from "../src/persistence/schema-fingerprint.js";
import { probeProviderReadiness } from "../src/runner/auth-probe.js";
import { needsApiKeyEnv, providerKeyEnv } from "../src/runner/provider-env.js";
import { reapStalePiAuthLock } from "../src/runner/auth-lock.js";
import { probeCredentialRoundTrip } from "../src/runner/credential-roundtrip.js";
import { defaultDesignLintBinary, pinnedDesignLint } from "../src/verify/design-lint-binary.js";
import { judgeApprovals, type ApprovalSubject } from "../src/judge/approval-intent.js";
import { judgeBusinessLanguage } from "../src/judge/business-language.js";
import { judgeHumanSentences } from "../src/judge/human-sentence.js";
import { judgeVerticalSlices, type JudgedStory } from "../src/judge/vertical-slice.js";
import { judgeEnvironmentReasons } from "../src/judge/environment-reasons.js";
import {
  approvalJudgeSetup,
  businessLanguageJudgeSetup,
  environmentJudgeSetup,
  judgeConfigFrom,
  readabilityJudgeSetup,
  verticalSliceJudgeSetup,
} from "../src/judge/settings.js";
import { assertErrorFixtureCoverage } from "../src/runner/error-fixtures.js";
import { assertProviderRetriesDisabled } from "../src/runner/failover.js";
import { assertModelPolicy, ModelPolicy } from "../src/runner/model-policy.js";
import { defaultModelCatalog } from "../src/runner/catalog.js";
import { defaultPiBinary, pinnedPiVersion } from "../src/runner/pi-binary.js";
import { checkoutPath, redactRemoteUrl } from "../src/vcs/repository-checkout.js";
import { RepositoryRegistry } from "../src/vcs/repository-registry.js";
import { piModelDeclarationsPath } from "../src/runner/pi-model-declarations.js";
import { pinnedSolPiRef, solPiExtensionPath } from "../src/runner/sol-pi.js";

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

/** One real refusal, from the recorded exchange, so the probe asks the judge
 * something a card actually produced rather than a sentence written for it. */
function knownEnvironmentRefusal(): string {
  const recorded = JSON.parse(
    readFileSync(new URL("../fixtures/judge/environment-reasons.json", import.meta.url), "utf8"),
  ) as { exchanges: { want: string; request: { state: { reason: string } } }[] };
  const environment = recorded.exchanges.find((exchange) => exchange.want === "environment");
  if (!environment) throw new Error("the recorded judge exchanges carry no environment case");
  return environment.request.state.reason;
}

/** One real approval, from the recorded exchange, so the probe asks the judge
 * something a person actually wrote rather than a sentence written for it. */
function knownApproval(): { comment: string; subject: ApprovalSubject } {
  const recorded = JSON.parse(
    readFileSync(new URL("../fixtures/judge/approval-comments.json", import.meta.url), "utf8"),
  ) as { exchanges: { want: string; subject: ApprovalSubject; request: { state: { comment: string } } }[] };
  const approval = recorded.exchanges.find((exchange) => exchange.want === "approval");
  if (!approval) throw new Error("the recorded judge exchanges carry no approval case");
  return { comment: approval.request.state.comment, subject: approval.subject };
}

/** One real line of each kind, from the recorded exchange: the construction
 * the word table cannot see, and the product whose own subject matter is
 * technical, which must not be refused a second time. */
function knownDecompositionLines(): { refuse: string; pass: string } {
  const recorded = JSON.parse(
    readFileSync(new URL("../fixtures/judge/decomposition-lines.json", import.meta.url), "utf8"),
  ) as { exchanges: { want: string; note: string; request: { state: { sentence: string } } }[] };
  const refuse = recorded.exchanges.find((exchange) => exchange.want === "implementation");
  const pass = recorded.exchanges.find((exchange) => exchange.note.includes("subject matter is technical"));
  if (!refuse || !pass) throw new Error("the recorded judge exchanges are missing a decomposition case");
  return { refuse: refuse.request.state.sentence, pass: pass.request.state.sentence };
}

let judgeProbe: number | undefined;

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
  const workRoot = resolve(optional("--work-root") ?? join(ROOT, "data", "work"));
  const piBinary = defaultPiBinary();

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

  // An abandoned credential lock means the last pi on this host was killed
  // mid-refresh. It is cleared rather than reported as broken, because the next
  // spawn would otherwise stall for pi's whole staleness window with no output
  // at all; a lock a peer worker still holds is left alone and reported.
  await attempt("pi credential lock is free", async () => {
    const lock = await reapStalePiAuthLock();
    if (lock.reaped) return `cleared a lock abandoned ${Math.round(lock.ageMs! / 1000)}s ago`;
    if (lock.ageMs !== null) return `held by another process for ${Math.round(lock.ageMs / 1000)}s`;
    return "no lock";
  }, "WARN");

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
  // Separate from the migration probe above: a database created by an earlier
  // 0001 records itself as migrated, so "migrates" passing says nothing about
  // what the file enforces.
  await attempt("the database enforces what the migrations declare", async () => {
    await assertSchemaCurrent(handle.client);
    return (await schemaFingerprint(handle.client)).digest.slice(0, 12);
  });

  if (config) {
    const catalog = defaultModelCatalog(piBinary);
    await attempt("every configured model id exists in its provider's catalogue", () => assertModelPolicy(config!, catalog));
    await attempt("provider retries are disabled (failover owns retries)", () => assertProviderRetriesDisabled(config!));
    await attempt("an out-of-band alert channel is configured", () =>
      assertOutOfBandChannel(new AlertRouter(alertChannelsFromConfig(stored)), config!, (message) => {
        throw new Error(message);
      }), "WARN");

    const policy = new ModelPolicy(config, catalog, piModelDeclarationsPath());
    const chain = config.get("model.failoverChain");
    const severity = chain.length > 1 ? "WARN" : "FAIL";
    await attempt("every provider in the chain has captured failure wordings", () => {
      assertErrorFixtureCoverage(chain);
      return Promise.resolve(chain.join(", "));
    });
    for (const provider of chain) {
      // An api_key provider's key reaches pi only if something puts it there.
      // systemd gives the daemons the secrets file; a preflight run by hand
      // gets nothing, and pi then reports the provider as unconfigured — which
      // reads exactly like a credential nobody ever added.
      let providerEnv: Record<string, string> | undefined;
      await attempt(`provider ${provider} key reaches pi`, async () => {
        const profile = await policy.profileOf(provider);
        if (!needsApiKeyEnv(profile)) {
          providerEnv = {};
          return "oauth; credential lives in pi's auth file";
        }
        providerEnv = providerKeyEnv({
          provider,
          ...(profile.envKey ? { envKey: profile.envKey } : {}),
          secrets: stored,
          secretsPath,
        });
        return Object.keys(providerEnv)[0]!;
      }, severity);
      // Without the key, the probes below would fail for a reason that has
      // nothing to do with the credential being valid.
      if (providerEnv === undefined) continue;
      const spawnEnv = providerEnv;

      let configured = false;
      await attempt(`provider ${provider} credentials ready`, async () => {
        const readiness = await probeProviderReadiness(piBinary, provider, spawnEnv);
        if (!readiness.ready) throw new Error(readiness.reason ?? "not ready; run scripts/pi-login.sh");
        configured = true;
      }, severity);
      if (!configured) continue;
      // `auth check` only proves a credential is present. One tiny turn on the
      // cheap tier is what separates a working key from a revoked one.
      await attempt(`provider ${provider} answers a real turn`, async () => {
        const model = await policy.resolve("capacity_probe", provider);
        await probeCredentialRoundTrip({ binary: piBinary, provider, model, env: spawnEnv });
        return model.id;
      }, severity);
    }
    // Bound here because the narrowing above does not survive into the async
    // probe bodies below.
    const judgeConfig = config;
    // The judge is a second model path, outside pi and outside the failover
    // chain. It has no veto anywhere -- unreachable means the pattern tables
    // answer alone -- so only a switch that is on with nothing behind it is a
    // failure: that reads exactly like a judge that is answering.
    await attempt("structured judge", async () => {
      const { setup, settings } = environmentJudgeSetup(judgeConfigFrom(judgeConfig), stored);
      if (setup.kind === "off") return "off; the pattern tables answer alone";
      if (setup.kind === "no_credential") {
        throw new Error(`enabled but ${setup.key} is missing from ${secretsPath}`);
      }
      const started = Date.now();
      const judgement = await judgeEnvironmentReasons(settings!.judge, [knownEnvironmentRefusal()], {
        model: settings!.model,
        // Asked at zero so the round trip is proved here and the calibration is
        // judged on its own line: a judge that answers is a different fact from
        // a judge that still answers this one the way it used to.
        threshold: 0,
      });
      if (judgement.error) throw new Error(judgement.error);
      if (judgement.moved.length === 0) throw new Error("the judge returned no answer for the probe refusal");
      judgeProbe = judgement.moved[0]!.probability;
      return `${judgeConfig.get("judge.model")} answered in ${Date.now() - started}ms`;
    });
    if (judgeProbe !== undefined) {
      await attempt("judge still reads a known environment refusal as one", async () => {
        const threshold = judgeConfig.get("judge.environmentThreshold");
        if (judgeProbe! < threshold) {
          throw new Error(`the recorded refusal scored ${judgeProbe!.toFixed(2)}, below the ${threshold} threshold; the tables still answer, but the judge is adding nothing`);
        }
        return `${judgeProbe!.toFixed(2)} against a ${threshold} threshold`;
      }, "WARN");
    }
    // The second question the judge answers. It shares the client and the
    // switch, so an unreachable service is already reported above; what is
    // checked here is that this question still lands where it was calibrated.
    await attempt("judge still reads a known approval as one", async () => {
      const { settings } = approvalJudgeSetup(judgeConfigFrom(judgeConfig), stored);
      if (!settings) return "off; the comment whitelist answers alone";
      const approval = knownApproval();
      const judgement = await judgeApprovals(settings.judge, [approval.comment], approval.subject, {
        model: settings.model,
        threshold: settings.threshold,
      });
      if (judgement.error) throw new Error(judgement.error);
      if (judgement.moved.length === 0) {
        throw new Error(`the recorded approval did not reach the ${settings.threshold} threshold; the whitelist still answers, but the judge is adding nothing`);
      }
      return `${judgement.moved[0]!.probability.toFixed(2)} against a ${settings.threshold} threshold`;
    }, "WARN");
    // The third question. Both directions are checked: the line it has to
    // refuse and the line it must not, because this question can only add
    // refusals and an invented one blocks an Epic.
    await attempt("judge still reads a known implementation line as one", async () => {
      const { settings } = businessLanguageJudgeSetup(judgeConfigFrom(judgeConfig), stored);
      if (!settings) return "off; the word table answers alone";
      const lines = knownDecompositionLines();
      const judgement = await judgeBusinessLanguage(settings.judge, [
        { field: "probe refuse", line: 1, text: lines.refuse },
        { field: "probe pass", line: 1, text: lines.pass },
      ], { model: settings.model, threshold: settings.threshold });
      if (judgement.error) throw new Error(judgement.error);
      const refused = new Set(judgement.moved.map((entry) => entry.text));
      if (!refused.has(lines.refuse)) {
        throw new Error(`the recorded implementation line did not reach the ${settings.threshold} threshold; the table still answers, but the judge is adding nothing`);
      }
      if (refused.has(lines.pass)) {
        throw new Error("the judge refused a line whose subject matter is legitimately technical; that refusal would block an Epic");
      }
      return `refused one and passed one against a ${settings.threshold} threshold`;
    }, "WARN");
    // The fourth question. Both directions again: the shape it has to refuse
    // and the one it must not, because this question can only add refusals and
    // an invented one blocks an Epic.
    await attempt("judge still reads a known layer Story as one", async () => {
      const { settings } = verticalSliceJudgeSetup(judgeConfigFrom(judgeConfig), stored);
      if (!settings) return "off; the non-empty checks answer alone";
      const recorded = JSON.parse(
        readFileSync(new URL("../fixtures/judge/decomposition-slices.json", import.meta.url), "utf8"),
      ) as { exchanges: { want: string; expectRefused: boolean; request: { state: { story: JudgedStory } } }[] };
      const refuse = recorded.exchanges.find((exchange) => exchange.expectRefused);
      const pass = recorded.exchanges.find((exchange) => exchange.want === "slice");
      if (!refuse || !pass) throw new Error("the recorded judge exchanges are missing a slice case");
      const judgement = await judgeVerticalSlices(settings.judge, [
        { ...refuse.request.state.story, id: "PROBE-REFUSE" },
        { ...pass.request.state.story, id: "PROBE-PASS" },
      ], { model: settings.model, threshold: settings.threshold });
      if (judgement.error) throw new Error(judgement.error);
      const refused = new Set(judgement.moved.map((entry) => entry.storyId));
      if (!refused.has("PROBE-REFUSE")) {
        throw new Error(`the recorded layer Story did not reach the ${settings.threshold} threshold; the checks still answer, but the judge is adding nothing`);
      }
      if (refused.has("PROBE-PASS")) {
        throw new Error("the judge refused a Story a person can use on its own; that refusal would block an Epic");
      }
      return `refused one and passed one against a ${settings.threshold} threshold`;
    }, "WARN");
    // The fifth. It shares the decomposition question and its fixture, so only
    // its own bar is checked here: it sits lower because the two gates it runs
    // on ship whatever they find.
    await attempt("judge still reads a known implementation line as one for the report gates", async () => {
      const { settings } = readabilityJudgeSetup(judgeConfigFrom(judgeConfig), stored);
      if (!settings) return "off; the sentence linter answers alone";
      const lines = knownDecompositionLines();
      const judged = await judgeHumanSentences(settings.judge, `${lines.refuse}。${lines.pass}。`, {
        model: settings.model,
        threshold: settings.threshold,
        field: "design-summary",
        what: "probe",
      });
      const flagged = new Set(judged.map((finding) => finding.excerpt));
      if (![...flagged].some((excerpt) => excerpt.startsWith(lines.refuse.slice(0, 10)))) {
        throw new Error(`the recorded implementation line was not flagged at the ${settings.threshold} threshold; the linter still answers, but the judge is adding nothing`);
      }
      if ([...flagged].some((excerpt) => excerpt.startsWith(lines.pass.slice(0, 10)))) {
        throw new Error("the judge flagged a sentence about what a person can do; that costs a rewrite on every card");
      }
      return `flagged one and kept one against a ${settings.threshold} threshold`;
    }, "WARN");
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

  const registered = await new RepositoryRegistry(handle.client).list().catch(() => []);
  await attempt("at least one repository is registered", async () => {
    if (registered.length === 0) {
      throw new Error("run `npx tsx scripts/repository-add.ts <git-url>`; hivemind works in registered repositories only");
    }
    return registered.map((repository) => repository.slug).join(", ");
  });
  for (const repository of registered) {
    // Reachability, proved by asking the remote rather than by reading a
    // stored path: the credentials, not the disk, are what a card needs.
    await attempt(`${repository.slug} is reachable`, async () => {
      const head = await output("git", [
        "ls-remote", "--heads", repository.remoteUrl, `refs/heads/${repository.defaultBranch}`,
      ]).catch((error: unknown) => {
        throw new Error(redactRemoteUrl((error as Error).message.split("\n")[0] ?? "git ls-remote failed"));
      });
      const sha = head.split(/\s/)[0] ?? "";
      if (!sha) throw new Error(`the remote has no branch named ${repository.defaultBranch}`);
      return `${repository.defaultBranch}@${sha.slice(0, 12)}`;
    });
    await attempt(`${repository.slug} is checked out on this host`, async () => {
      const path = checkoutPath(workRoot, repository.slug);
      await stat(join(path, ".git"));
      return path;
    }, "WARN");
  }

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

  // Warn, not fail: this gate only records friction, so a host without it keeps
  // delivering. It is probed at all because a gate that quietly does nothing
  // looks exactly like a gate that keeps finding nothing.
  await attempt("pinned design detector for the prototype exit", async () => {
    const pin = pinnedDesignLint();
    const binary = defaultDesignLintBinary();
    const reported = await output(binary, ["--version"]);
    if (reported !== pin.reportedVersion) {
      throw new Error(
        `impeccable reports ${reported}, pinned engine-v${pin.engineVersion} reports ${pin.reportedVersion};`
        + " run scripts/install-design-lint.sh",
      );
    }
    return `impeccable ${reported} (engine-v${pin.engineVersion})`;
  }, "WARN");

  // A host whose configuration turns a mechanism on but never installed the
  // extension fails at spawn, with a pi-side error about a file it cannot load.
  // Asking here turns that into one line at startup. A host with both switches
  // off is told so rather than passed silently: "off" and "missing" look the
  // same from the outside, and only one of them is a decision.
  await attempt("SoL-Pi extension matches the configuration", async () => {
    const solPi = config?.get("agent.solPi") as { actionFusion: boolean; observationPack: boolean };
    if (!solPi) throw new Error("the configuration store never loaded, so the switches are unknown");
    const enabled = Object.entries(solPi).filter(([, on]) => on).map(([name]) => name);
    if (enabled.length === 0) return "no mechanism is enabled, so the extension is never loaded";
    const path = solPiExtensionPath();
    if (!existsSync(path)) {
      throw new Error(`${enabled.join(" and ")} enabled but ${path} is missing; run scripts/install-sol-pi.sh`);
    }
    return `${enabled.join(" and ")} at ${pinnedSolPiRef().slice(0, 12)}`;
  }, "WARN");

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
