import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CANONICAL_CAPTURE_ENV } from "../src/observability/capture-contract.js";
import { LibsqlPhaseRecorder } from "../src/observability/phase-recorder.js";
import { BlindVerifyStoryPort } from "../src/orchestrator/blind-verify-port.js";
import { PiStoryPhasePort } from "../src/orchestrator/pi-phase-port.js";
import { EpicIntegrator } from "../src/orchestrator/epic-integration.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";
import { EpicMergeFlow } from "../src/vcs/merge-flow.js";
import { blindSubsetVerifier } from "../src/vcs/subset-verifier.js";
import { LibsqlActualFootprintStore } from "../src/vcs/actual-footprint.js";
import { NotionStoryProjection } from "../src/notion/story-projection.js";
import { SingleStoryWorker } from "../src/orchestrator/story-worker.js";
import { PiCompletionJudge } from "../src/pipeline/completion-verifier.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { POLICY_ENV_VAR, serializeGuardPolicy, type GuardPolicy } from "../src/guard/policy.js";
import { probeProviderReadiness } from "../src/runner/auth-probe.js";
import { type ExplicitContextFile } from "../src/runner/context-files.js";
import { PiModelCatalog, resolveModel } from "../src/runner/model-resolver.js";
import { ConfigStore } from "../src/config/store.js";
import { ModelPolicy } from "../src/runner/model-policy.js";
import { retryLimits } from "../src/pipeline/retry-limits.js";
import { ScenarioRegistry } from "../src/regression/scenario-registry.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { BlindVerifyExecutor } from "../src/verify/executor.js";
import { discoverMRPort } from "../src/vcs/mr/adapters.js";
import { GitMrStoryDelivery, processGitCommand } from "../src/vcs/story-delivery.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function one(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function many(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  }
  return values;
}

function contextFiles(): ExplicitContextFile[] {
  return many("--context").map((value) => {
    const split = value.indexOf("=");
    if (split < 1 || split === value.length - 1) throw new Error("--context must be label=path");
    return { label: value.slice(0, split), path: resolve(value.slice(split + 1)) };
  });
}

function safeSegment(value: string): string {
  const safe = value.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  if (safe.length === 0) throw new Error("card id has no safe path characters");
  return safe;
}

async function gitMessages(worktreePath: string, targetBranch: string): Promise<string[]> {
  const result = await execFileAsync("git", ["log", "--format=%s", `${targetBranch}..HEAD`], {
    cwd: worktreePath,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

async function main(): Promise<void> {
  const cardId = one("--card-id");
  const worktreePath = resolve(one("--worktree"));
  const provider = one("--provider", "openai-codex");
  const modelId = one("--model");
  const targetBranch = one("--target-branch", "main");
  // Only a Story inside an Epic needs one; a standalone Story publishes its own
  // branch instead of landing on an integration branch.
  const integrationWorktree = process.argv.includes("--integration-worktree")
    ? resolve(one("--integration-worktree"))
    : null;
  const piBinary = resolve(one("--pi", join(
    homedir(), ".hivemind", "pi", "0.84.3", "pi", process.platform === "win32" ? "pi.exe" : "pi",
  )));
  const dbUrl = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
  const safeCardId = safeSegment(cardId);
  const evidenceRoot = resolve(one("--evidence-root", join(homedir(), ".hivemind", "evidence", safeCardId)));
  const sessionRoot = resolve(one("--session-root", join(homedir(), ".hivemind", "sessions", safeCardId)));
  const auditPath = join(evidenceRoot, "tool-audit.jsonl");
  const guardExtension = join(ROOT, "extensions", "hive-guard.ts");
  const canonicalExtension = join(ROOT, "extensions", "canonical-capture.ts");

  const readiness = await probeProviderReadiness(piBinary, provider);
  if (!readiness.ready) {
    throw new Error(`provider is not ready: ${provider} (${readiness.reason ?? "unknown reason"})`);
  }
  const model = await resolveModel(new PiModelCatalog({ binary: piBinary, cwd: worktreePath }), provider, modelId);
  const handle = openDb(dbUrl);
  try {
    await migrate(handle.client);
    const store = new StoryExecutionStore(handle.client);
    const story = await store.getStory(cardId);
    if (!["QUEUED", "DESIGN", "CODE", "MERGE"].includes(story.state)) {
      throw new Error(`Story ${cardId} must be QUEUED, DESIGN, CODE or MERGE, not ${story.state}`);
    }
    const recorder = new LibsqlPhaseRecorder(handle.client, {
      evidenceRoot,
      provider: model.provider,
      modelId: model.id,
      hostId: hostname(),
    });
    // The judge answers one yes/no question per phase exit; running it on the
    // phase's own tier is what made it the pipeline's quietest cost line.
    const config = await ConfigStore.load(handle.client);
    const limits = await retryLimits(config);
    // The same list feeds the guard, the browser and the verdict check; it is
    // read here once so no layer can drift from the others.
    const allowedHosts = config.get("guard.e2eHostAllowlist");
    const judgeModel = await new ModelPolicy(
      config,
      new PiModelCatalog({ binary: piBinary, cwd: worktreePath }),
    ).resolve("completion_judge", model.provider).catch((cause: unknown) => {
      // A provider with no cheap tier still gets a judge, but never silently:
      // the phase model is the expensive fallback, not the intended one.
      console.warn(`completion judge falls back to the phase model: ${(cause as Error).message}`);
      return model;
    });
    const completionJudge = new PiCompletionJudge(() => new RpcPiRunner({
      binary: piBinary,
      provider: judgeModel.provider,
      model: judgeModel,
      cwd: worktreePath,
      tools: [],
      contextFiles: "explicit",
    }));
    const phases = new PiStoryPhasePort({
      binary: piBinary,
      model,
      worktreePath,
      promptRoot: join(ROOT, "prompts"),
      sessionRoot,
      evidencePath: evidenceRoot,
      auditPath,
      guardExtension,
      canonicalCaptureExtension: canonicalExtension,
      completionJudge,
      contextFiles: contextFiles(),
      recordTelemetry: (input) => recorder.record(input),
      maxContinueRetries: limits.maxContinueRetries,
    });
    const blindExecutor = new BlindVerifyExecutor(
      {
        create: (policy: GuardPolicy) => new RpcPiRunner({
          binary: piBinary,
          provider: model.provider,
          model,
          cwd: worktreePath,
          sessionDir: join(sessionRoot, "verify"),
          tools: ["read", "bash", "grep", "find", "ls"],
          extensions: [guardExtension, canonicalExtension],
          contextFiles: "explicit",
          env: {
            [POLICY_ENV_VAR]: serializeGuardPolicy(policy),
            [CANONICAL_CAPTURE_ENV]: join(policy.extraWriteRoots[0]!, "provider-requests.jsonl"),
          },
        }),
      },
      { insert: async () => undefined },
    );
    const verifier = new BlindVerifyStoryPort({
      executor: blindExecutor,
      worktreePath,
      evidenceRoot,
      auditPath,
      allowedHosts,
      commitMessages: () => gitMessages(worktreePath, targetBranch),
      recordTelemetry: (input) => recorder.record(input),
    });
    const delivery = new GitMrStoryDelivery(await discoverMRPort(), {
      worktreePath,
      targetBranch,
      actualFootprints: new LibsqlActualFootprintStore(handle.client),
    });
    const integration = integrationWorktree
      ? new EpicIntegrator(
          handle.client,
          store,
          new EpicMergeFlow(
            processGitCommand,
            blindSubsetVerifier(blindExecutor, {
              cardId,
              round: 1,
              codeSessionId: `integration:${cardId}`,
              worktreePath: integrationWorktree,
              evidencePath: join(evidenceRoot, "integration"),
              auditPath,
              specification: JSON.stringify(await store.getDefinitionOfDone(cardId)),
              allowedHosts,
              commitMessages: [],
            }),
            { storyWorktree: worktreePath, integrationWorktree, mainBranch: targetBranch },
          ),
        )
      : undefined;
    const result = await new SingleStoryWorker(
      store,
      phases,
      verifier,
      delivery,
      new NotionStoryProjection(handle.client),
      {
        ...(integration ? { integration } : {}),
        maxInnerLoopRounds: limits.maxInnerLoopRounds,
      },
    ).run(cardId);
    // The scenarios a Story declares become the regression pools' problem the
    // moment they exist, and everyone's problem once the Story is delivered.
    const registry = new ScenarioRegistry(handle.client);
    await registry.registerStory(cardId).catch((cause: unknown) => {
      console.warn(`scenario registration skipped: ${(cause as Error).message}`);
    });
    if (result.state === "DELIVERED") await registry.promoteToMain(cardId);
    console.log(JSON.stringify(result));
  } finally {
    handle.close();
  }
}

main().catch((error: unknown) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
