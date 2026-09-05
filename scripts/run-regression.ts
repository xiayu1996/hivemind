// Runs one regression sweep in its own process, the way a Story runs in one:
// the orchestrator decides what to sweep, this decides how, and the result is
// reported as JSON on stdout.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ConfigStore } from "../src/config/store.js";
import { POLICY_ENV_VAR, serializeGuardPolicy, type GuardPolicy } from "../src/guard/policy.js";
import { CANONICAL_CAPTURE_ENV } from "../src/observability/capture-contract.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { attributeCard, attributionSequence } from "../src/regression/attribution-runner.js";
import { BlindSweepPort } from "../src/regression/blind-sweep-port.js";
import { ScenarioRegistry, type ScenarioPool } from "../src/regression/scenario-registry.js";
import { RegressionStore, regressionPolicy } from "../src/regression/store.js";
import { RegressionSweeper } from "../src/regression/sweeper.js";
import { PiModelCatalog, resolveModel } from "../src/runner/model-resolver.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import { browserLanePath } from "../src/verify/browser-config.js";
import { loadPromptLayers } from "../src/pipeline/prompt-loader.js";
import { BlindVerifyExecutor } from "../src/verify/executor.js";
import { processGitCommand } from "../src/vcs/story-delivery.js";

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
  const epicId = process.argv.includes("--epic") ? one("--epic") : null;
  const provider = one("--provider", "openai-codex");
  const modelId = one("--model");
  const piBinary = resolve(one("--pi", defaultPiBinary()));
  const evidenceRoot = resolve(one("--evidence-root", join(homedir(), ".hivemind", "evidence", `regression-${pool}`)));
  const probeWorktree = process.argv.includes("--probe-worktree") ? resolve(one("--probe-worktree")) : null;
  const auditPath = join(evidenceRoot, "tool-audit.jsonl");
  const dbUrl = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";

  const model = await resolveModel(new PiModelCatalog({ binary: piBinary, cwd: worktreePath }), provider, modelId);
  const handle = openDb(dbUrl);
  try {
    await migrate(handle.client);
    const config = await ConfigStore.load(handle.client);
    const registry = new ScenarioRegistry(handle.client);
    const store = new RegressionStore(handle.client);
    const policy = await regressionPolicy(config);
    const allowedHosts = config.get("guard.e2eHostAllowlist");
    const verifyLayers = await loadPromptLayers(join(ROOT, "prompts"), "VERIFY");

    const executor = new BlindVerifyExecutor(
      {
        create: (guard: GuardPolicy) => new RpcPiRunner({
          binary: piBinary,
          provider: model.provider,
          model,
          cwd: guard.extraWriteRoots[0] ?? worktreePath,
          sessionDir: join(evidenceRoot, "sessions"),
          tools: ["read", "bash", "grep", "find", "ls"],
          extensions: [join(ROOT, "extensions", "hive-guard.ts"), join(ROOT, "extensions", "canonical-capture.ts")],
          contextFiles: "explicit",
          systemPrompt: { mode: "replace", text: verifyLayers.combined },
          env: {
            PATH: browserLanePath(ROOT),
            [POLICY_ENV_VAR]: serializeGuardPolicy(guard),
            [CANONICAL_CAPTURE_ENV]: join(guard.extraWriteRoots[0] ?? evidenceRoot, "provider-requests.jsonl"),
          },
        }),
      },
      { insert: async () => undefined },
      {
        capture: () => ({ head: "", digest: "" }),
        quarantine: async () => undefined,
      },
    );

    const sweepPort = new BlindSweepPort({
      worktreeFor: async () => worktreePath,
      executor,
      git: processGitCommand,
      evidenceRoot,
      auditPath,
      allowedHosts,
      chromiumSandbox: config.get("verify.chromiumSandbox"),
    });
    const result = await new RegressionSweeper(registry, store, sweepPort).sweep({ pool, branch, scenarioIds }, policy);

    // A raised card is only actionable once it names the Story that broke it.
    const attributions = [];
    if (epicId && probeWorktree && result.raised.length > 0) {
      const sequence = await attributionSequence(handle.client, epicId);
      const probeSweep = new BlindSweepPort({
        worktreeFor: async () => probeWorktree,
        executor,
        git: processGitCommand,
        evidenceRoot: join(evidenceRoot, "probe"),
        auditPath,
        allowedHosts,
      chromiumSandbox: config.get("verify.chromiumSandbox"),
      });
      for (const raised of result.raised) {
        const card = { scenarioId: raised.scenarioId, failureSignature: raised.signature };
        const attribution = await attributeCard(handle.client, store, card, sequence, async (revision, scenarioId) => {
          await execFileAsync("git", ["checkout", "--detach", revision], { cwd: probeWorktree, windowsHide: true });
          const probed = await probeSweep.run({ pool, branch: revision, scenarioIds: [scenarioId] });
          return probed.outcomes.some((outcome) => outcome.outcome === "failed");
        });
        attributions.push({ ...card, attribution });
      }
    }
    console.log(JSON.stringify({ ...result, attributions }));
  } finally {
    handle.close();
  }
}

main().catch((error: unknown) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
