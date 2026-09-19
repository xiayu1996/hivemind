// Runs one regression sweep in its own process, the way a Story runs in one:
// the orchestrator decides what to sweep, this decides how, and the result is
// reported as JSON on stdout.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "../src/config/store.js";
import { cacheRetentionEnv } from "../src/runner/cache-retention.js";
import { POLICY_ENV_VAR, serializeGuardPolicy, type GuardPolicy } from "../src/guard/policy.js";
import { CANONICAL_CAPTURE_ENV } from "../src/observability/capture-contract.js";
import { absoluteDbUrl, openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { attributeCard, attributionSequence } from "../src/regression/attribution-runner.js";
import { BlindSweepPort } from "../src/regression/blind-sweep-port.js";
import { ScenarioRegistry, type ScenarioPool } from "../src/regression/scenario-registry.js";
import { sweepRepository } from "../src/regression/sweep-repository.js";
import { RegressionStore, regressionPolicy } from "../src/regression/store.js";
import { RegressionSweeper } from "../src/regression/sweeper.js";
import { resolveModel } from "../src/runner/model-resolver.js";
import { resolveAgentSpec } from "../src/runner/agent-spec.js";
import { defaultModelCatalog } from "../src/runner/catalog.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import { browserLanePath } from "../src/verify/browser-config.js";
import { loadPromptLayers } from "../src/pipeline/prompt-loader.js";
import { BlindVerifyExecutor, EVIDENCE_DIR_ENV } from "../src/verify/executor.js";
import { processGitCommand } from "../src/vcs/story-delivery.js";
import { appLaneConfig } from "../src/verify/app-lane.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function one(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const pool = one("--pool") as ScenarioPool;
  if (pool !== "epic" && pool !== "main") throw new Error("--pool must be epic or main");
  const branch = one("--branch");
  const worktreePath = resolve(one("--worktree"));
  const scenarioIds = one("--scenarios").split(",").map((id) => id.trim()).filter(Boolean);
  const repositoryFlag = process.argv.includes("--repository") ? one("--repository") : null;
  const epicId = process.argv.includes("--epic") ? one("--epic") : null;
  const provider = one("--provider", "openai-codex");
  const modelId = one("--model");
  const piBinary = resolve(one("--pi", defaultPiBinary()));
  const evidenceRoot = resolve(one("--evidence-root", join(homedir(), ".hivemind", "evidence", `regression-${pool}`)));
  const probeWorktree = process.argv.includes("--probe-worktree") ? resolve(one("--probe-worktree")) : null;
  const auditPath = join(evidenceRoot, "tool-audit.jsonl");
  const dbUrl = absoluteDbUrl(process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db");
  // Everything this process starts reads the database this process resolved.
  // The application a verification round starts runs in the worktree under
  // verification, inherits this environment, and a relative address means a
  // different file there -- or no file at all, which is what it got.
  process.env.HIVEMIND_DB_URL = dbUrl;

  const model = await resolveModel(defaultModelCatalog(piBinary, worktreePath), provider, modelId);
  const handle = openDb(dbUrl);
  try {
    await migrate(handle.client);
    // Per-repo settings -- how this repository starts its application, which
    // hosts the browser may reach. An unscoped sweep read the code defaults
    // instead and judged the same scenario without the application the Story's
    // own round was handed, which is the disagreement between the two lanes
    // that verify.appStartCommand exists to end.
    const repository = repositoryFlag
      ?? await sweepRepository(handle.client, { epicId, scenarioIds });
    const config = await ConfigStore.load(handle.client, { repository });
    // The sweep spawns the verifier once per pool run, on the provider this
    // invocation names; there is no failover chain to walk inside a sweep and
    // no provider capacity to hold beyond it.
    const sweepSpec = await resolveAgentSpec({
      config,
      policy: {
        resolve: async () => model,
        providersFor: async () => [provider],
        tierOf: async () => "standard",
        isMetered: async () => false,
      },
    }, "verify", provider);
    const sweepGrant = async () => ({ spec: sweepSpec, release: async () => undefined });
    const registry = new ScenarioRegistry(handle.client);
    const store = new RegressionStore(handle.client);
    const policy = await regressionPolicy(config);
    const allowedHosts = config.get("guard.e2eHostAllowlist");
    const verifyLayers = await loadPromptLayers(join(ROOT, "prompts"), "VERIFY");

    const executor = new BlindVerifyExecutor(
      {
        create: (guard: GuardPolicy, _spec, browserEnv) => new RpcPiRunner({
          binary: piBinary,
          provider: model.provider,
          model,
          cwd: guard.extraWriteRoots[0] ?? worktreePath,
          sessionDir: join(evidenceRoot, "sessions"),
          tools: [...sweepSpec.tools],
          skillDiscovery: "explicit",
          skills: [...sweepSpec.skills],
          extensions: [join(ROOT, "extensions", "hive-guard.ts"), join(ROOT, "extensions", "canonical-capture.ts")],
          contextFiles: "explicit",
          systemPrompt: { mode: "replace", text: verifyLayers.combined },
          env: {
            PATH: browserLanePath(ROOT),
            ...browserEnv,
            ...cacheRetentionEnv(config),
            [POLICY_ENV_VAR]: serializeGuardPolicy(guard),
            [CANONICAL_CAPTURE_ENV]: join(guard.extraWriteRoots[0] ?? evidenceRoot, "provider-requests.jsonl"),
            [EVIDENCE_DIR_ENV]: guard.extraWriteRoots[0] ?? evidenceRoot,
          },
        }),
      },
      { insert: async () => undefined },
      {
        capture: () => ({ head: "", digest: "" }),
        quarantine: async () => undefined,
      },
    );

    // The frozen text each scenario was accepted against. The sweep judges the
    // same words the Story was judged on; naming only the ids asked the
    // verifier to guess the scenario and then grade its own guess.
    const specificationFor = async (ids: readonly string[]): Promise<ReadonlyMap<string, string>> => {
      const rows = (await handle.client.execute({
        sql: `SELECT spec_id, text FROM story_specs WHERE spec_id IN (${ids.map(() => "?").join(", ")})`,
        args: [...ids],
      })).rows;
      return new Map(rows.map((row) => [String(row.spec_id), String(row.text)]));
    };

    const sweepPort = new BlindSweepPort({
      worktreeFor: async () => worktreePath,
      specificationFor,
      executor,
      git: processGitCommand,
      evidenceRoot,
      auditPath,
      resolveSpec: sweepGrant,
      allowedHosts,
      app: appLaneConfig(config),
      chromiumSandbox: config.get("verify.chromiumSandbox"),
    });
    const result = await new RegressionSweeper(registry, store, sweepPort).sweep({ pool, branch, scenarioIds }, policy);

    // A card is only actionable once it names the Story that has to answer for
    // it, so every ownerless card is offered an owner again this sweep -- not
    // only the ones raised just now. One that found none stayed ownerless for
    // good, open and unreachable, holding its Epic at the review gate.
    const attributions = [];
    let attributionsSkipped: string | undefined;
    const pending = (await store.unattributedCards(result.failed))
      .map((card) => ({ scenarioId: card.scenarioId, failureSignature: card.failureSignature }));
    if (pending.length > 0 && !(epicId && probeWorktree)) {
      attributionsSkipped = probeWorktree ? "no epic" : "no probe worktree";
    }
    if (epicId && probeWorktree && pending.length > 0) {
      const sequence = await attributionSequence(handle.client, epicId);
      const probeSweep = new BlindSweepPort({
        worktreeFor: async () => probeWorktree,
        specificationFor,
        executor,
        git: processGitCommand,
        evidenceRoot: join(evidenceRoot, "probe"),
        auditPath,
        resolveSpec: sweepGrant,
        allowedHosts,
        app: appLaneConfig(config),
        chromiumSandbox: config.get("verify.chromiumSandbox"),
      });
      try {
        for (const card of pending) {
          const attribution = await attributeCard(handle.client, store, card, sequence, async (revision, scenarioId) => {
            await execFileAsync("git", ["checkout", "--detach", revision], { cwd: probeWorktree, windowsHide: true });
            const probed = await probeSweep.run({ pool, branch: revision, scenarioIds: [scenarioId] });
            return probed.outcomes.some((outcome) => outcome.outcome === "failed");
          });
          attributions.push({ ...card, attribution });
        }
      } finally {
        // Back to the tip, still detached. Checking the branch out here claimed
        // a branch the sweep worktree already holds, and git refuses that: the
        // restore failed, the sweep exited non-zero, and no regression could
        // run for any Epic that had a live worktree. Detached is the right
        // resting state anyway - the sweep reads HEAD, never the branch name.
        await execFileAsync("git", ["checkout", "--detach", branch], { cwd: probeWorktree, windowsHide: true });
      }
    }
    console.log(JSON.stringify({ ...result, attributions, ...(attributionsSkipped ? { attributionsSkipped } : {}) }));
  } finally {
    handle.close();
  }
}

main().catch((error: unknown) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
