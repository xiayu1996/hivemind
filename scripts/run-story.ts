import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { readInterfaceContract } from "../src/pipeline/interface-contract.js";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CANONICAL_CAPTURE_ENV } from "../src/observability/capture-contract.js";
import { LibsqlPhaseRecorder } from "../src/observability/phase-recorder.js";
import { EventBuffer } from "../src/observability/event-buffer.js";
import { DrainLoop } from "../src/observability/drain.js";
import { phaseEvidenceSink } from "../src/observability/phase-evidence-sink.js";
import { BlindVerifyStoryPort } from "../src/orchestrator/blind-verify-port.js";
import { UiReviewedVerifyPort } from "../src/orchestrator/ui-reviewed-verify-port.js";
import { UiReviewExecutor } from "../src/verify/ui-review.js";
import { loadPmPromptLayers } from "../src/pipeline/prompt-loader.js";
import { PiStoryPhasePort } from "../src/orchestrator/pi-phase-port.js";
import { EpicIntegrator } from "../src/orchestrator/epic-integration.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";
import { EpicMergeFlow } from "../src/vcs/merge-flow.js";
import { testSubsetVerifier } from "../src/vcs/subset-verifier.js";
import { runProjectCheck } from "../src/vcs/project-check-runner.js";
import { captureTreePin } from "../src/guard/tree-pin.js";
import { quarantineWorktree, worktreeLayout } from "../src/vcs/worktree.js";
import { LibsqlActualFootprintStore } from "../src/vcs/actual-footprint.js";
import { NotionStoryProjection } from "../src/notion/story-projection.js";
import { SingleStoryWorker } from "../src/orchestrator/story-worker.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { POLICY_ENV_VAR, serializeGuardPolicy, type GuardPolicy } from "../src/guard/policy.js";
import { probeProviderReadiness } from "../src/runner/auth-probe.js";
import { breakerPolicy, usableProviders } from "../src/runner/circuit-breaker.js";
import { classifyError } from "../src/runner/classify.js";
import { LibsqlProviderHealthStore } from "../src/runner/provider-health-store.js";
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { describeJudgeSetup, environmentJudgeSetup, judgeConfigFrom } from "../src/judge/settings.js";
import { renderMovedReasons } from "../src/judge/environment-reasons.js";
import { needsApiKeyEnv, providerKeyEnv } from "../src/runner/provider-env.js";
import { cacheRetentionEnv } from "../src/runner/cache-retention.js";
import type { ProviderProfile } from "../src/runner/model-policy.js";
import { type ExplicitContextFile } from "../src/runner/context-files.js";
import { defaultModelCatalog } from "../src/runner/catalog.js";
import { ModelPolicy } from "../src/runner/model-policy.js";
import { SpawnBroker } from "../src/runner/spawn-broker.js";
import { ProviderSlotStore } from "../src/queue/provider-slots.js";
import { LeaseStore, holderKey, type LeaseHolder } from "../src/persistence/lease.js";
import { resolveAgentSpec } from "../src/runner/agent-spec.js";
import type { CacheKeyScope } from "../src/runner/session-file.js";
import type { StoryState } from "../src/orchestrator/state-machine.js";
import { ConfigStore } from "../src/config/store.js";
import { CostLedger } from "../src/observability/cost-ledger.js";
import { costCeilingUsd } from "../src/pipeline/cost-ceiling.js";
import { retryLimits } from "../src/pipeline/retry-limits.js";
import { specifyGatePorts } from "../src/pipeline/specify-gate.js";
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

/** Long enough to outlive one phase, short enough that a killed worker's card
 * comes back on the next sweep rather than the next day. */
const LEASE_TTL_MS = 15 * 60_000;
/** Provider capacity is heartbeaten by the spawn that holds it; this is how
 * long a slot survives with nobody heartbeating it. */
const SLOT_LEASE_MS = 10 * 60_000;

/** States a card can legitimately be picked up in. VERIFY is here because a run
 * can die inside it; the worker sends such a card back to CODE rather than
 * refusing it, which is what kept a single transport fault from being
 * recoverable at all. */
const RUNNABLE_STATES: StoryState[] = [
  "QUEUED", "SHAPE", "DESIGN", "SPECIFY", "CODE", "VERIFY", "MERGE", "REGRESSION_FIX",
];

/** The screen reviewer's spec, on the first provider of its tier that can
 * actually see an image. A text-only reviewer judging a layout is theatre. */
async function resolveUiReviewSpec(config: ConfigStore, policy: ModelPolicy) {
  const providers = await policy.providersFor("ui_review");
  for (const provider of providers) {
    const spec = await resolveAgentSpec({ config, policy }, "ui_review", provider);
    if (spec.model.images === true) return spec;
    console.warn(`UI review skips ${spec.model.id}: it does not accept image input`);
  }
  throw new Error("no provider in the ui_review tier accepts image input");
}

/** Whether any provider this card may reach bills for tokens. */
async function anyMeteredProvider(policy: ModelPolicy, chain: readonly string[]): Promise<boolean> {
  for (const provider of chain) {
    if (await policy.isMetered(provider).catch(() => false)) return true;
  }
  return false;
}

/** This execution's identity. Two subprocesses on one host are two of these,
 * and the lease refuses the second: the host alone would let both in. */
function executionInstanceId(): string {
  return `${process.pid}-${randomUUID().slice(0, 8)}`;
}

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


async function git(worktreePath: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: worktreePath,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

/** The tree a verdict was reached on. A conclusion carried onto a tree that
 * has moved is a conclusion about code nobody verified. */
async function currentTreeSha(worktreePath: string): Promise<string> {
  const result = await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: worktreePath,
    windowsHide: true,
  });
  return result.stdout.trim();
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

  const instance: LeaseHolder = { hostId: hostname(), instanceId: executionInstanceId() };

  const handle = openDb(dbUrl);
  let held: { fence: number } | null = null;
  const providerHealth = new LibsqlProviderHealthStore(handle.client);
  let events = new EventBuffer();
  let drain: DrainLoop | null = null;
  // What a provider fault would be attributed to. A card may fail over more
  // than once inside one execution, so the provider actually spawned last is
  // the only honest answer -- and the coordinator that forked this process
  // cannot see it at all. Held in an object because it is written from a
  // callback and read after it.
  const spawned: { provider: string | null; config: ConfigStore | null } = { provider: null, config: null };
  const leases = new LeaseStore(handle.client, { ttlMs: LEASE_TTL_MS });
  const slots = new ProviderSlotStore(handle.client, { leaseMs: SLOT_LEASE_MS });
  try {
    await migrate(handle.client);
    // Claim the card from the database rather than being handed it on the
    // command line. Two subprocesses racing for one card end with exactly one
    // holder, and every write below carries this fence, so a holder that was
    // revoked while it was away cannot come back and write.
    const lease = await leases.acquire(cardId, instance);
    if (!lease) {
      const current = await leases.get(cardId);
      throw new Error(`Story ${cardId} is already held by ${current?.holder ?? "another execution"}`);
    }
    held = { fence: lease.fence };
    const fence = lease.fence;
    const store = new StoryExecutionStore(handle.client, Date.now, {
      assert: (id) => leases.assertHolds(id, instance, fence),
    });
    const story = await store.getStory(cardId);
    // VERIFY is here because a run can die inside it; the worker sends such a
    // card back to CODE rather than refusing it, which is what kept a single
    // transport fault from being recoverable at all.
    if (!RUNNABLE_STATES.includes(story.state)) {
      throw new Error(`Story ${cardId} must be one of ${RUNNABLE_STATES.join(", ")}, not ${story.state}`);
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
    const modelPolicy = new ModelPolicy(config, defaultModelCatalog(piBinary, worktreePath));
    // Credentials for every provider this card may reach, read once. A phase
    // resolves its own provider now, so being handed one provider's key on the
    // command line would leave the first failover spawning pi with nothing.
    const secretsPath = join(homedir(), ".hivemind", "secrets.env");
    const secrets = await loadSecretsFile(secretsPath);
    const providerEnv = new Map<string, Record<string, string>>();
    for (const [name, profile] of Object.entries(config.get("model.providers") as Record<string, ProviderProfile>)) {
      if (!needsApiKeyEnv(profile)) continue;
      try {
        providerEnv.set(name, providerKeyEnv({
          provider: name,
          ...(profile.envKey ? { envKey: profile.envKey } : {}),
          secrets,
          secretsPath,
        }));
      } catch {
        // No key on this host for a provider this card may never reach. The
        // readiness probe reports it as a reason to fail over; refusing to
        // start here would make one unused provider fatal for every card.
      }
    }
    // Credential plus the cache window every spawn of this card runs under:
    // the key and the prefix order only pay off while the entry is still there
    // when the next phase asks for it.
    const cacheEnv = cacheRetentionEnv(config);
    const providerEnvFor = (provider: string): Record<string, string> => ({
      ...cacheEnv,
      ...providerEnv.get(provider),
    });
    spawned.config = config;
    // Provider, model, tier, reasoning effort and billing are all resolved per
    // phase, through one broker that also holds the provider's capacity for the
    // length of the spawn. Reading them once at startup is what made every
    // phase run on the CODE tier, and what left a card that started on a
    // subscription and failed over to a metered API running with no ceiling.
    const broker = new SpawnBroker({
      config,
      policy: modelPolicy,
      slots,
      cardId,
      holder: holderKey(instance),
      // `pi auth check` exits zero even when it is not ready, so the probe reads
      // the status rather than the exit code; a provider that fails it is failed
      // over, not fatal.
      ready: async (provider) => probeProviderReadiness(piBinary, provider, providerEnvFor(provider)),
      // The breaker is central, so a provider another card just found broken
      // is skipped here too rather than being rediscovered once per card.
      unhealthy: async () => {
        const healths = await providerHealth.snapshot();
        const names = [...healths.keys()];
        const open = new Set(usableProviders(names, healths, Date.now()));
        return new Set(names.filter((name) => !open.has(name)));
      },
    });
    const grant = async (purpose: Parameters<typeof broker.grant>[0]) => {
      const granted = await broker.grant(purpose);
      spawned.provider = granted.spec.model.provider;
      return granted;
    };
    // Whether a spend ceiling means anything for this card is decided by
    // whether any provider it may run on bills for tokens, not by the one it
    // starts on: a failover mid-card changes the answer, and the ledger only
    // ever counts metered rows, so the port reads zero while a card stays on a
    // subscription and starts counting the moment it does not.
    const chainIsMetered = await anyMeteredProvider(modelPolicy, config.get("model.failoverChain"));
    const recorder = new LibsqlPhaseRecorder(handle.client, {
      evidenceRoot,
      hostId: hostname(),
    });
    // Observation is a side channel: the phases enqueue and move on, and this
    // loop writes the evidence behind them. Killing it loses evidence and
    // stalls no card, which is the property the whole arrangement exists for.
    events = new EventBuffer();
    drain = new DrainLoop(events, [phaseEvidenceSink(recorder)], {
      onSinkFailure: (sink, error) => {
        console.warn(`observability sink ${sink} failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    drain.start();
    const limits = await retryLimits(config);
    const frozenContract = await store.frozenTestContract(cardId);
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
      resolveSpec: (purpose) => grant(purpose),
      providerEnv: providerEnvFor,
      cacheKeyScope: config.get("cache.keyScope") as CacheKeyScope,
      ...(story.repo ? { repoId: story.repo } : {}),
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
        testPathPatterns: config.get("codeExit.testPathPatterns"),
        protectedPaths: config.get("codeExit.protectedPaths"),
        // Only set once SPECIFY has frozen something; a card driven without it
        // is measured by the checks that still apply rather than by a diff
        // against a commit that does not exist.
        ...(frozenContract ? { frozenTestCommit: frozenContract.specifyCommit } : {}),
      },
      contextFiles: contextFiles(),
      recordCost: (input) => recorder.recordCost(input),
      emit: (type, data) => events.emit(type, data),
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
    // Asked only about the refusals the pattern table did not recognise, and
    // only ever to move one off the code side. Absent or unreachable, the table
    // is the whole answer, which is what every deployment without the
    // credential gets.
    const judged = environmentJudgeSetup(
      judgeConfigFrom(config),
      secrets,
      async (judgement) => {
        if (judgement.moved.length === 0) return;
        await store.recordFriction({
          cardId,
          runId: `verify:${cardId}`,
          kind: "verify_environment_judged",
          detail: renderMovedReasons(judgement.moved),
        });
      },
    );
    const judgeNote = describeJudgeSetup(judged.setup);
    if (judgeNote) console.warn(judgeNote);
    const environmentJudge = judged.settings;
    const blindExecutor = new BlindVerifyExecutor(
      {
        // The spec is the one granted for this verification, so the verifier
        // moves with a failover and its tool surface comes from the same
        // configuration every other phase reads.
        create: (policy: GuardPolicy, spec, browserEnv) => new RpcPiRunner({
          binary: piBinary,
          provider: spec.model.provider,
          model: spec.model,
          cwd: worktreePath,
          sessionDir: join(sessionRoot, "verify"),
          tools: [...spec.tools],
          skillDiscovery: "explicit",
          skills: [...spec.skills],
          extensions: [guardExtension, canonicalExtension],
          contextFiles: "explicit",
          systemPrompt: { mode: "replace", text: verifyLayers.combined },
          env: {
            PATH: browserLanePath(ROOT),
            ...browserEnv,
            ...providerEnvFor(spec.model.provider),
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
      Date.now,
      environmentJudge,
    );
    const verifier = new BlindVerifyStoryPort({
      executor: blindExecutor,
      worktreePath,
      evidenceRoot,
      auditPath,
      allowedHosts,
      chromiumSandbox: config.get("verify.chromiumSandbox"),
      resolveSpec: () => grant("verify"),
      commitMessages: () => gitMessages(worktreePath, targetBranch),
      recordCost: (input) => recorder.recordCost(input),
      emit: (type, data) => events.emit(type, data),
    });
    // The product manager's acceptance of the interface, in its own session
    // with its own eyes. It only reviews what the functional lane already
    // accepted, and only a model that can actually see the screens: a
    // text-only reviewer judging a layout is theatre, so the lane is skipped
    // and said out loud instead.
    const uiReviewSpec = config.get("verify.uiReview")
      ? await resolveUiReviewSpec(config, modelPolicy).catch((cause: unknown) => {
        console.warn(`UI review lane disabled: ${(cause as Error).message}`);
        return undefined;
      })
      : undefined;
    const uiReviewModel = uiReviewSpec?.model;
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
          create: (policy, _images, browserEnv) => new RpcPiRunner({
            binary: piBinary,
            provider: uiReviewSpec!.model.provider,
            model: uiReviewSpec!.model,
            cwd: worktreePath,
            sessionDir: join(sessionRoot, "ui-review"),
            tools: [...uiReviewSpec!.tools],
            skillDiscovery: "explicit",
            skills: [...uiReviewSpec!.skills],
            extensions: [guardExtension, canonicalExtension],
            contextFiles: "explicit",
            systemPrompt: { mode: "replace", text: uiReviewLayers.combined },
            env: {
              PATH: browserLanePath(ROOT),
              ...browserEnv,
              ...providerEnvFor(uiReviewSpec!.model.provider),
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
        // The lane the table misses most: the reviewer stands its own harness
        // up, so what it refuses on is prose about a box it built itself.
        ...(environmentJudge ? { environmentJudge } : {}),
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
            // Deterministic re-verification: the repository's own checks, run
            // on whichever tree the flow names - the rebased Story, and the
            // Epic head when the first run failed. The browser sweep that used
            // to run here belongs to the regression loop (03 section 8.3).
            testSubsetVerifier(
              { run: (check, cwd) => runProjectCheck(cwd, check) },
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
        specifyExitRounds: config.get("specifyExit.maxRounds"),
        convergence: { oscillationLookback: limits.oscillationLookback },
        treeSha: () => currentTreeSha(worktreePath),
        // Read per phase off the worktree, so a card picks up a contract that
        // changed on the branch between two of its own rounds. A half-written
        // one is left out rather than injected: a phase told to build against
        // a table that is missing half its colours invents the rest.
        interfaceContract: async () => {
          const read = await readInterfaceContract(join(worktreePath, config.get("prototype.root")));
          if (read.kind === "incomplete") {
            console.warn(`interface contract ignored: ${read.reasons.join("; ")}`);
          }
          return read.kind === "present" ? read.contract : null;
        },
        specify: {
          // The tree the phase entered on, not a DESIGN commit: a card
          // re-entered by hand, and a delivered card running a narrow
          // regression pass, both have legitimate implementation in the tree.
          baseCommit: async () => (await git(worktreePath, ["rev-parse", "HEAD"])).trim(),
          testPathPatterns: () => config.get("codeExit.testPathPatterns"),
          ports: () => specifyGatePorts({
            worktreePath,
            git: (args) => git(worktreePath, args),
            command: {
              run: async (argv) => {
                const [command, ...args] = argv;
                try {
                  const done = await execFileAsync(command!, args, {
                    cwd: worktreePath,
                    windowsHide: true,
                    maxBuffer: 16 * 1024 * 1024,
                    env: process.env,
                  });
                  return { stdout: done.stdout, stderr: done.stderr, ok: true };
                } catch (cause) {
                  // Tests that fail are the point here, so a non-zero exit is
                  // the report's carrier rather than an error.
                  const failed = cause as { stdout?: string; stderr?: string };
                  return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? String(cause), ok: false };
                }
              },
            },
            testCommand: config.get("specifyExit.testCommand"),
            testPathPatterns: config.get("codeExit.testPathPatterns"),
          }),
        },
        friction: { record: (input) => store.recordFriction(input) },
        // A flat-rate subscription has no money to cap, and a port that
        // always answered zero would read as a ceiling being enforced when
        // nothing is. The question is whether this card can ever reach a
        // metered provider, because a failover mid-card would otherwise leave
        // the real spending with no ceiling attached.
        ...(chainIsMetered ? { spend: spendPort } : {}),
      },
    ).run(cardId);
    // The scenarios a Story declares become its Epic's pool the moment they
    // exist. They stay there: a delivered Story is on its Epic's integration
    // branch, and only the Epic landing on the target branch makes them
    // everyone's problem. EpicCompletion promotes them when it reads the
    // merge.
    const registry = new ScenarioRegistry(handle.client);
    await registry.registerStory(cardId).catch((cause: unknown) => {
      console.warn(`scenario registration skipped: ${(cause as Error).message}`);
    });
    // A card that got all the way through proves the provider it finished on
    // is serving, which is what closes a breaker that a probe alone leaves
    // half open.
    if (spawned.provider) await providerHealth.recordSuccess(spawned.provider).catch(() => undefined);
    console.log(JSON.stringify(result));
  } catch (error) {
    // Only a failure the error catalogue recognises says anything about the
    // provider; a defect of ours must not open its breaker. The coordinator
    // that forked this process cannot make this call, because the provider is
    // chosen in here and may have changed more than once.
    const message = error instanceof Error ? error.message : String(error);
    if (spawned.provider && spawned.config && classifyError(message).class !== "UNKNOWN") {
      await providerHealth.recordFailure(spawned.provider, message, await breakerPolicy(spawned.config))
        .catch(() => undefined);
    }
    throw error;
  } finally {
    // Give the card and the provider capacity back even when the run failed:
    // a slot nobody released is capacity the next card waits for until it
    // expires, and a lease nobody released is a card nobody picks up.
    // Last pass before the process goes away, so the tail of the evidence is
    // not lost with it. It writes what is already buffered and nothing more.
    await drain?.stop().catch(() => undefined);
    if (events.dropped > 0) console.warn(`observability dropped ${events.dropped} event(s) under back pressure`);
    await slots.releaseHolder(holderKey(instance)).catch(() => undefined);
    if (held) await leases.release(cardId, instance, held.fence).catch(() => undefined);
    handle.close();
  }
}

main().catch((error: unknown) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
