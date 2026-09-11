import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CANONICAL_CAPTURE_ENV } from "../src/observability/capture-contract.js";
import { LibsqlPhaseRecorder } from "../src/observability/phase-recorder.js";
import { BlindVerifyStoryPort } from "../src/orchestrator/blind-verify-port.js";
import { UiReviewedVerifyPort } from "../src/orchestrator/ui-reviewed-verify-port.js";
import { UiReviewExecutor } from "../src/verify/ui-review.js";
import { loadPmPromptLayers } from "../src/pipeline/prompt-loader.js";
import { PiStoryPhasePort } from "../src/orchestrator/pi-phase-port.js";
import { EpicIntegrator } from "../src/orchestrator/epic-integration.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";
import { EpicMergeFlow } from "../src/vcs/merge-flow.js";
import { testSubsetVerifier } from "../src/vcs/subset-verifier.js";
import { captureTreePin } from "../src/guard/tree-pin.js";
import { quarantineWorktree, worktreeLayout } from "../src/vcs/worktree.js";
import { LibsqlActualFootprintStore } from "../src/vcs/actual-footprint.js";
import { NotionStoryProjection } from "../src/notion/story-projection.js";
import { SingleStoryWorker } from "../src/orchestrator/story-worker.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { POLICY_ENV_VAR, serializeGuardPolicy, type GuardPolicy } from "../src/guard/policy.js";
import { probeProviderReadiness } from "../src/runner/auth-probe.js";
import { type ExplicitContextFile } from "../src/runner/context-files.js";
import { resolveModel } from "../src/runner/model-resolver.js";
import { defaultModelCatalog } from "../src/runner/catalog.js";
import { ModelPolicy } from "../src/runner/model-policy.js";
import { ConfigStore } from "../src/config/store.js";
import { CostLedger } from "../src/observability/cost-ledger.js";
import { isMeteredProvider } from "../src/runner/provider-env.js";
import { costCeilingUsd } from "../src/pipeline/cost-ceiling.js";
import { retryLimits } from "../src/pipeline/retry-limits.js";
import { ScenarioRegistry } from "../src/regression/scenario-registry.js";
import { RpcPiRunner } from "../src/runner/rpc-runner.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import { browserLanePath } from "../src/verify/browser-config.js";
import { BlindVerifyExecutor, EVIDENCE_DIR_ENV } from "../src/verify/executor.js";
import { loadPromptLayers } from "../src/pipeline/prompt-loader.js";
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

/** Runs one declared check where the merge is being verified. */
async function runCheck(
  cwd: string,
  check: { name: string; command: readonly string[] },
): Promise<{ passed: boolean; detail: string }> {
  const [command, ...args] = check.command;
  try {
    const done = await execFileAsync(command!, args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { passed: true, detail: done.stdout.trim().slice(-2000) };
  } catch (cause) {
    const output = `${(cause as { stdout?: string }).stdout ?? ""}${(cause as { stderr?: string }).stderr ?? ""}`.trim();
    return { passed: false, detail: (output === "" ? (cause as Error).message : output).slice(-2000) };
  }
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
  const piBinary = resolve(one("--pi", defaultPiBinary()));
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
  const model = await resolveModel(defaultModelCatalog(piBinary, worktreePath), provider, modelId);
  const handle = openDb(dbUrl);
  try {
    await migrate(handle.client);
    const store = new StoryExecutionStore(handle.client);
    const story = await store.getStory(cardId);
    // VERIFY is here because a run can die inside it; the worker sends such a
    // card back to CODE rather than refusing it, which is what kept a single
    // transport fault from being recoverable at all.
    if (!["QUEUED", "DESIGN", "CODE", "VERIFY", "MERGE", "REGRESSION_FIX"].includes(story.state)) {
      throw new Error(
        `Story ${cardId} must be QUEUED, DESIGN, CODE, VERIFY, MERGE or REGRESSION_FIX, not ${story.state}`,
      );
    }
    // A regression fix lands on the Epic head again; without the integration
    // worktree the loop could fix and never deliver.
    if (story.state === "REGRESSION_FIX" && !integrationWorktree) {
      throw new Error(`Story ${cardId} is in REGRESSION_FIX and needs --integration-worktree`);
    }
    // Per-repository keys (the gate commands the CODE exit and the merge
    // re-verification run) are stored under the card's slug; without the scope
    // they would read as their defaults and an unchecked merge would pass.
    const config = await ConfigStore.load(handle.client, story.repo ? { repository: story.repo } : {});
    // Whether this card's tokens cost money as they are spent decides two
    // things: what the ledger counts as billed, and whether a spend ceiling
    // means anything for this run at all.
    const modelPolicy = new ModelPolicy(config, defaultModelCatalog(piBinary, worktreePath));
    const metered = isMeteredProvider(await modelPolicy.profileOf(provider));
    const recorder = new LibsqlPhaseRecorder(handle.client, {
      evidenceRoot,
      provider: model.provider,
      modelId: model.id,
      hostId: hostname(),
      isSubscription: !metered,
    });
    const limits = await retryLimits(config);
    const ledger = new CostLedger(handle.client);
    const spendPort = {
      cardSpend: (id: string) => ledger.cardSpend(id),
      // Read per check rather than once per run: raising the ceiling is how a
      // person resumes a card that already stopped on it.
      ceilingUsd: () => costCeilingUsd(config),
      spendByPhase: (id: string) => ledger.cardSpendByPhase(id),
    };
    // The same list feeds the guard, the browser and the verdict check; it is
    // read here once so no layer can drift from the others.
    const allowedHosts = config.get("guard.e2eHostAllowlist");
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
      // A Story inside an Epic lands on the Epic head, so its own commits are
      // the ones after the branch point with the target, not after its tip.
      codeExit: {
        baseRef: targetBranch,
        projectChecks: config.get("codeExit.projectChecks"),
        maxRounds: config.get("codeExit.maxRounds"),
      },
      contextFiles: contextFiles(),
      recordTelemetry: (input) => recorder.record(input),
      maxContinueRetries: limits.maxContinueRetries,
      promptTimeoutMs: limits.promptTimeoutMs,
    });
    // The verifier runs under its own phase contract, and with the browser
    // lane's CLI on its PATH; nothing is installed into the worktree for it.
    const verifyLayers = await loadPromptLayers(join(ROOT, "prompts"), "VERIFY");
    // The worktree lives under <work root>/worktrees/<repo>/<card>; a tree that
    // changed during VERIFY is moved to the quarantine root beside it, so the
    // round is rejected with evidence instead of the worker dying.
    const layout = worktreeLayout(resolve(worktreePath, "..", "..", ".."));
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
          systemPrompt: { mode: "replace", text: verifyLayers.combined },
          env: {
            PATH: browserLanePath(ROOT),
            [POLICY_ENV_VAR]: serializeGuardPolicy(policy),
            [CANONICAL_CAPTURE_ENV]: join(policy.extraWriteRoots[0]!, "provider-requests.jsonl"),
            [EVIDENCE_DIR_ENV]: policy.extraWriteRoots[0]!,
          },
        }),
      },
      { insert: async () => undefined },
      {
        capture: captureTreePin,
        quarantine: async (path, reason) => {
          await quarantineWorktree(path, reason, layout);
        },
      },
    );
    const verifier = new BlindVerifyStoryPort({
      executor: blindExecutor,
      worktreePath,
      evidenceRoot,
      auditPath,
      allowedHosts,
      chromiumSandbox: config.get("verify.chromiumSandbox"),
      commitMessages: () => gitMessages(worktreePath, targetBranch),
      recordTelemetry: (input) => recorder.record(input),
    });
    // The product manager's acceptance of the interface, in its own session
    // with its own eyes. It only reviews what the functional lane already
    // accepted, and only a model that can actually see the screens: a
    // text-only reviewer judging a layout is theatre, so the lane is skipped
    // and said out loud instead.
    const uiReviewModel = config.get("verify.uiReview")
      ? await modelPolicy.resolve("ui_review", provider).catch((cause: unknown) => {
        console.warn(`UI review lane disabled: ${(cause as Error).message}`);
        return undefined;
      })
      : undefined;
    if (uiReviewModel && uiReviewModel.images !== true) {
      console.warn(`UI review lane disabled: ${uiReviewModel.id} does not accept image input`);
    }
    const uiReviewLayers = uiReviewModel?.images === true
      ? await loadPmPromptLayers(join(ROOT, "prompts"), "UI_REVIEW")
      : undefined;
    const reviewedVerifier = uiReviewModel && uiReviewLayers
      ? new UiReviewedVerifyPort({
        functional: verifier,
        review: new UiReviewExecutor({
          create: (policy) => new RpcPiRunner({
            binary: piBinary,
            provider: uiReviewModel.provider,
            model: uiReviewModel,
            cwd: worktreePath,
            sessionDir: join(sessionRoot, "ui-review"),
            tools: ["read", "bash", "grep", "find", "ls"],
            extensions: [guardExtension, canonicalExtension],
            contextFiles: "explicit",
            systemPrompt: { mode: "replace", text: uiReviewLayers.combined },
            env: {
              PATH: browserLanePath(ROOT),
              [POLICY_ENV_VAR]: serializeGuardPolicy(policy),
              [CANONICAL_CAPTURE_ENV]: join(policy.extraWriteRoots[0]!, "ui-review-requests.jsonl"),
              [EVIDENCE_DIR_ENV]: policy.extraWriteRoots[0]!,
            },
          }),
        }),
        worktreePath,
        evidenceRoot,
        auditPath,
        allowedHosts,
        chromiumSandbox: config.get("verify.chromiumSandbox"),
        // The application the reviewer looks at, started and seeded by the
        // system; a reviewer told to "open the page" with nothing running
        // returns inconclusive for every scenario, which is what happened on
        // the first run under this contract.
        app: {
          startCommand: config.get("verify.appStartCommand"),
          readyUrl: config.get("verify.appReadyUrl"),
          readyTimeoutMs: config.get("verify.appReadyTimeoutMs"),
          seedCommand: config.get("verify.seedCommand"),
        },
        storyTitle: async () => {
          const snapshot = await store.getStory(cardId);
          return { title: snapshot.title, businessGoal: snapshot.requirement };
        },
        recordFriction: (friction) => store.recordFriction(friction),
      })
      : verifier;
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
            // Deterministic re-verification: the repository's own checks, run on
            // the integration branch. The browser sweep that used to run here
            // belongs to the regression loop (03 section 8.3).
            testSubsetVerifier(
              { run: (check) => runCheck(integrationWorktree, check) },
              config.get("codeExit.projectChecks"),
            ),
            { storyWorktree: worktreePath, integrationWorktree, mainBranch: targetBranch },
          ),
        )
      : undefined;
    const result = await new SingleStoryWorker(
      store,
      phases,
      reviewedVerifier,
      delivery,
      new NotionStoryProjection(handle.client),
      {
        ...(integration ? { integration } : {}),
        maxInnerLoopRounds: limits.maxInnerLoopRounds,
        maxRegressionReopens: limits.maxRegressionReopens,
        friction: { record: (input) => store.recordFriction(input) },
        // A flat-rate subscription has no money to cap, and a port that
        // always answered zero would read as a ceiling being enforced when
        // nothing is.
        ...(metered ? { spend: spendPort } : {}),
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
