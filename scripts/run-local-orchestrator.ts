import type { Row } from "@libsql/client";
import { execFile, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { alertChannelsFromConfig } from "../src/alert/config.js";
import { AlertRouter } from "../src/alert/index.js";
import { assertOutOfBandChannel } from "../src/alert/required-channel.js";
import { ScenarioRegistry } from "../src/regression/scenario-registry.js";
import { planRegressionSweep } from "../src/regression/scheduler.js";
import { defaultSecretsPath, loadSecretsFile, upsertSecretFile } from "../src/config/secrets-file.js";
import { ConfigStore } from "../src/config/store.js";
import { breakerPolicy, intakeHalted, usableProviders } from "../src/runner/circuit-breaker.js";
import {
  AllProvidersUnavailableError,
  ProviderDeferredError,
  runWithFailover,
} from "../src/runner/failover.js";
import { classifyError } from "../src/runner/classify.js";
import { settleDispatchFailure } from "../src/orchestrator/dispatch-failure.js";
import { renderStopSummary } from "../src/orchestrator/stop-summary.js";
import { epicTransitionStatement } from "../src/orchestrator/state-machine.js";
import {
  AlertStopSink,
  FrictionStopSink,
  notifyStoryStopped,
  type StoryStopSink,
} from "../src/orchestrator/story-stop-sink.js";
import { assertProviderRetriesDisabled } from "../src/runner/failover.js";
import { probeProviderReadiness, refreshProviderCredentials } from "../src/runner/auth-probe.js";
import { assertCredentialRefreshCoverage } from "../src/runner/auth-refresh.js";
import { refreshCredentialsOnce } from "../src/runner/auth-refresh.js";
import { probeOpenProviders } from "../src/runner/provider-probe.js";
import { assertErrorFixtureCoverage } from "../src/runner/error-fixtures.js";
import { assertModelPolicy, ModelPolicy } from "../src/runner/model-policy.js";
import { needsApiKeyEnv, providerKeyEnv } from "../src/runner/provider-env.js";
import { defaultModelCatalog } from "../src/runner/catalog.js";
import { LibsqlProviderHealthStore } from "../src/runner/provider-health-store.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import { CommentIngestor } from "../src/notion/comment-ingest.js";
import {
  approvalJudgeSetup,
  businessLanguageJudgeSetup,
  judgeConfigFrom,
  verticalSliceJudgeSetup,
} from "../src/judge/settings.js";
import { NotionEpicInputSync } from "../src/notion/epic-input-sync.js";
import { NotionGateway, NotionGatewayError } from "../src/notion/gateway.js";
import { NotionMediaReconciler } from "../src/notion/media-reconciler.js";
import { NotionMediaPipeline } from "../src/notion/media.js";
import { NotionOutbox } from "../src/notion/outbox.js";
import { createTodoDecisionDelivery } from "../src/notion/todo-decision-delivery.js";
import { NotionUserDirectory } from "../src/notion/user-directory.js";
import {
  NotionGatewayCommentSource,
  NotionGatewayMediaPort,
  createNotionHttpTransport,
} from "../src/notion/sdk-adapters.js";
import { NotionGatewayStoryApi, ingestReadyStories } from "../src/notion/story-intake.js";
import { NotionStoryInputSync } from "../src/notion/story-input-sync.js";
import { NotionStoryPageDelivery } from "../src/notion/story-page-delivery.js";
import {
  NotionStoryDelivery,
  NotionStoryPropertyDelivery,
  STORY_OUTBOX_OPERATIONS,
  STORY_WHOLE_STATE_OPERATIONS,
} from "../src/notion/story-property-delivery.js";
import { NotionEpicPlanDelivery } from "../src/notion/epic-plan-delivery.js";
import { ingestEpicsForDecomposition } from "../src/notion/epic-intake.js";
import { EpicDecomposer } from "../src/orchestrator/decompose-runner.js";
import { PiDecomposePort } from "../src/orchestrator/pi-decompose-port.js";
import type { ExplicitContextFile } from "../src/runner/context-files.js";
import { EpicBranchFreshness } from "../src/orchestrator/epic-branch-refresh.js";
import { surfaceBlockedEpics } from "../src/orchestrator/epic-blocker.js";
import { EpicCompletion } from "../src/orchestrator/epic-completion.js";
import { EpicMrDelivery } from "../src/vcs/epic-delivery.js";
import { escalateParkedStories } from "../src/orchestrator/epic-escalation.js";
import { enqueueEpicPages } from "../src/orchestrator/epic-page-projection.js";
import { epicRegressionClean, epicsAwaitingDelivery, scenariosAwaitingDelivery } from "../src/regression/epic-gate.js";
import { describeOrphanedCard, readOrphanedCards } from "../src/regression/orphaned-cards.js";
import { discoverMRPort } from "../src/vcs/mr/adapters.js";
import { NotionStoryProjection } from "../src/notion/story-projection.js";
import { NotionSyncCoordinator, type NotionSyncPoller } from "../src/notion/sync.js";
import { registerNotionWebhookRoute } from "../src/notion/webhook-route.js";
import { IntegrationDispatchStore } from "../src/orchestrator/integration-dispatch.js";
import { EpicAcceptance } from "../src/orchestrator/epic-acceptance.js";
import { PlanApprovalStore } from "../src/orchestrator/plan-approval.js";
import { DispatchQueue } from "../src/queue/dispatch.js";
import { CostLedger } from "../src/observability/cost-ledger.js";
import { CANONICAL_CAPTURE_ENV } from "../src/observability/capture-contract.js";
import { finishLaneCapture, laneCapturePath, packFinishedCaptures } from "../src/observability/lane-capture.js";
import { createConsoleServer, listenConsole } from "../src/console/server.js";
import { LibsqlConsoleDataSource } from "../src/console/libsql-data-source.js";
import type { ConsoleTodoReadPort } from "../src/console/todo-contract.js";
import { listPendingTodos, readPendingTodo } from "../src/orchestrator/pending-todo.js";
import { createTodoDecisionDrain, createTodoDecisionStore } from "../src/orchestrator/todo-decision.js";
import { ProjectionService } from "../src/observability/projections/service.js";
import { ConsoleConfigWriter } from "../src/console/config-writer.js";
import { resolveAgentSpec } from "../src/runner/agent-spec.js";
import { cacheRetentionEnv } from "../src/runner/cache-retention.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";
import { absoluteDbUrl, openDb } from "../src/persistence/client.js";
import { holdDaemonSingleton } from "../src/orchestrator/daemon-singleton.js";
import { migrate } from "../src/persistence/migrate.js";
import { assertSchemaCurrent } from "../src/persistence/schema-fingerprint.js";
import { createWorktree, locateWorktree, retireWorktree, worktreeLayout } from "../src/vcs/worktree.js";
import { publishEpicBranch } from "../src/vcs/epic-branch.js";
import { processGitCommand } from "../src/vcs/story-delivery.js";
import { checkoutKey, checkoutPath, ensureCheckout, processRemoteGit, remoteDefaultBranch } from "../src/vcs/repository-checkout.js";
import { RepositoryRegistry } from "../src/vcs/repository-registry.js";
import { planDispatchAcrossRepositories } from "../src/orchestrator/repository-dispatch.js";
import type { RepositoryStory } from "../src/orchestrator/scheduler.js";
import { readInterfaceContract } from "../src/pipeline/interface-contract.js";
import { runProjectCheck } from "../src/vcs/project-check-runner.js";
import { recheckEpicHeads } from "../src/orchestrator/epic-head-recheck.js";
import { reopenRejectedDecompositions } from "../src/orchestrator/decomposition-reopen.js";
import { unrecoveredHeadFailures } from "../src/orchestrator/epic-head-failure.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** How often the outbox is emptied while the process is draining. The cycle is
 * no longer running, and a Story that changes state during a drain must still
 * reach the board. */
const DRAIN_OUTBOX_INTERVAL_MS = 15_000;

/**
 * The revision of the installation this process is running, which is what says
 * whether a decision was made by the criteria in force today. Read from this
 * repository rather than the working directory, so a service started from
 * anywhere reports its own code. Unreadable means an empty string, and the
 * callers treat that as "cannot tell": nothing is retried on a guess.
 */
async function installedRevision(): Promise<string> {
  return await processGitCommand.run(ROOT, ["rev-parse", "HEAD"])
    .then((sha) => sha.trim())
    .catch(() => "");
}

/**
 * The repository's own conventions, loaded into every DECOMPOSE and Story phase
 * under the same label so the system-prompt prefix is identical across them. A
 * repository without the file simply gets no context section.
 */
async function repositoryContextFiles(repositoryPath: string): Promise<ExplicitContextFile[]> {
  const path = join(repositoryPath, "AGENTS.md");
  return (await exists(path)) ? [{ label: "repository", path }] : [];
}

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function currentBranch(path: string): Promise<string> {
  const result = await execFileAsync("git", ["branch", "--show-current"], { cwd: path, windowsHide: true });
  return result.stdout.trim();
}

/**
 * One step of the cycle, isolated from a transient network fault. The steps
 * that talk to Notion or to the remote fail whenever the link blinks, and
 * they run before the steps that dispatch cards and land branches: letting
 * one of them abort the cycle stalls the whole pipeline until the link comes
 * back. A fault that retrying can clear is skipped for this cycle; anything
 * that needs a decision still stops it.
 *
 * The test is retryability rather than one class, because a link that blinks
 * says so in more than one wording. A Notion request that hit its deadline
 * reads as TIMEOUT, not TRANSPORT, and cost a whole cycle -- dispatch, Epic
 * upkeep and the regression sweep -- plus a P0 about a request that would
 * have succeeded on the next pass.
 */
/** The JSON the regression sweep prints as its last line. */
interface SweepSummary {
  failed?: readonly string[];
  attributions?: readonly { scenarioId: string; attribution?: { kind?: string } }[];
  attributionsSkipped?: string;
}

const step = async (name: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    const message = (error as Error).message;
    if (!classifyError(message).retryable) throw error;
    console.warn(`${name} was skipped this cycle after a transient network fault: ${message}`);
  }
};

/**
 * The single path segment every per-repository directory is keyed by:
 * worktrees, sessions and evidence all sit under it.
 */
function repositoryIdFor(slug: string): string {
  return checkoutKey(slug);
}

/** A `file:` URL made absolute against this process's cwd; anything else is
 * left as it is, since a remote libsql URL has no cwd to resolve against. */
async function main(): Promise<void> {
  const stored = await loadSecretsFile();
  const token = process.env.NOTION_TOKEN ?? stored.get("NOTION_TOKEN");
  const dataSourceId = process.env.HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID ??
    stored.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID");
  const webhookSecret = process.env.HIVEMIND_NOTION_WEBHOOK_SECRET ??
    stored.get("HIVEMIND_NOTION_WEBHOOK_SECRET");
  const epicsDataSourceId = process.env.HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID ??
    stored.get("HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID");
  if (!token) throw new Error("NOTION_TOKEN is missing from ~/.hivemind/secrets.env");
  if (!dataSourceId) throw new Error("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID is missing");
  const alertChannels = alertChannelsFromConfig(stored);
  const alerts = new AlertRouter(alertChannels);
  const secretsPath = defaultSecretsPath();

  // The chain and the tier map decide which provider serves a card; the flags
  // stay as an operator override for a single run.
  const providerOverride = optional("--provider");
  const modelOverride = optional("--model");
  const workRoot = resolve(optional("--work-root") ?? join(ROOT, "data", "work"));
  // The branch the repository integrates into; regression sweeps of the main
  // pool run against it, and Epic worktrees are cut from it.
  const boardTargetBranch = optional("--target-branch") ?? "main";
  const intervalMs = Number(optional("--interval-ms") ?? "10000");
  const once = process.argv.includes("--once");
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error("--interval-ms must be at least 1000");

  // Absolute, because this value is handed to child processes that do not share
  // this cwd: a Story run resolves it from the repository root, but the
  // application a verification round starts resolves it from the worktree under
  // verification, where data/ does not exist at all.
  const dbUrl = absoluteDbUrl(process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db");
  const handle = openDb(dbUrl);
  await migrate(handle.client);
  // Before the first card is picked up. A database an older 0001 created
  // records itself as migrated while enforcing the older constraints, and the
  // first thing that notices is a write failing inside somebody's Story.
  await assertSchemaCurrent(handle.client);
  // Before the gateway exists. This process is the only writer of Notion and
  // of every system-owned field, and a second one would break the premise the
  // store relies on to skip conflict resolution, so the claim is taken before
  // anything that could write.
  // Assigned once the Story children are known; until then losing the claim
  // can only mean stopping, because nothing has been dispatched yet.
  let onClaimLost: ((reason: string) => void) | undefined;
  const singleton = await holdDaemonSingleton(handle.client, "orchestrator", {
    hostId: hostname(),
    onLost: (reason) => {
      if (onClaimLost !== undefined) {
        onClaimLost(reason);
        return;
      }
      console.error(`FAILED: this orchestrator no longer holds the role (${reason})`);
      process.exit(1);
    },
  });
  const gateway = new NotionGateway({
    transport: createNotionHttpTransport({ token }),
  });
  const store = new StoryExecutionStore(handle.client);
  const repositories = new RepositoryRegistry(handle.client);
  // Self-registration from the flags, for a host that has only ever been told
  // a URL (or an operator's existing checkout, whose origin is the same fact
  // written down differently). Registration is idempotent, so this is also the
  // upgrade path.
  const bootstrapPath = optional("--repository-path");
  const bootstrapUrl = optional("--repository-url") ?? (bootstrapPath
    ? (await processRemoteGit.run(["remote", "get-url", "origin"], resolve(bootstrapPath))).stdout.trim()
    : undefined);
  if (bootstrapUrl) {
    const registration = await repositories.register({
      remoteUrl: bootstrapUrl,
      defaultBranch: optional("--default-branch") ?? await remoteDefaultBranch(bootstrapUrl),
      registeredBy: `orchestrator@${hostname()}`,
    });
    if (registration.created) console.log(`Registered ${registration.repository.slug}`);
  }
  const registered = await repositories.list();
  // Fail fast rather than idle forever: a host with no repository has nothing
  // it could ever dispatch, and the reason has to be readable at startup.
  if (registered.length === 0) {
    throw new Error("no repository is registered; run `npx tsx scripts/repository-add.ts <git-url>` first");
  }
  console.log(`Managing repositories: ${registered.map((repository) => repository.slug).join(", ")}`);
  // Repositories this cycle may work in. A checkout that could not be brought
  // up to date is dropped for the cycle, never for good.
  let servable = registered;
  const checkoutOf = (slug: string): string => checkoutPath(workRoot, slug);
  const repoOf = async (table: "stories" | "epics", id: string): Promise<string> => {
    const row = (await handle.client.execute({ sql: `SELECT repo FROM ${table} WHERE id = ?`, args: [id] })).rows[0];
    const slug = String(row?.repo ?? "");
    if (!slug) throw new Error(`${id} declares no repository`);
    return slug;
  };
  // Per-repository keys (the gate commands, the hotspot paths) are stored
  // under the card slug, so each repository needs its own view of the
  // configuration or those keys silently read as their defaults.
  const configs = new Map<string, ConfigStore>();
  const configFor = async (slug: string): Promise<ConfigStore> => {
    let scoped = configs.get(slug);
    if (!scoped) {
      scoped = await ConfigStore.load(handle.client, { repository: slug });
      configs.set(slug, scoped);
    }
    await scoped.reload();
    return scoped;
  };
  // The global view, for the keys that are not a repository's business (the
  // schedule limits this host applies, the console, the provider policy).
  const config = await ConfigStore.load(handle.client);
  /**
   * Makes a freshly cut worktree usable, by the repository's own account of
   * what that takes.
   *
   * A checkout is not a working tree: for most repositories it has no
   * dependencies installed, so the first phase that runs the tests finds
   * nothing to run them with. The first real requirement hit this at SPECIFY
   * on every Story, and one of them symlinked the host's `node_modules` in to
   * get past it -- a tree that then builds against whatever the host happens
   * to have. hivemind does not decide how somebody else's repository is
   * prepared, so the command is theirs to declare; declaring none says a
   * checkout is ready as it stands.
   */
  const prepareWorktree = async (worktreePath: string, slug: string): Promise<void> => {
    const scoped = await configFor(slug);
    const command = scoped.get("worktree.setupCommand");
    if (command.length === 0) return;
    const [binary, ...args] = command;
    console.log(`preparing ${worktreePath}: ${command.join(" ")}`);
    await execFileAsync(binary!, args, {
      cwd: worktreePath,
      windowsHide: true,
      timeout: scoped.get("worktree.setupTimeoutMs"),
      maxBuffer: 16 * 1024 * 1024,
    });
  };
  // The Epic's integration branch goes to origin the moment its Stories exist:
  // every Story's draft MR targets it and delivery reads it from origin.
  const publishEpicBranchFor = async (epicId: string): Promise<void> => {
    try {
      const repositoryPath = checkoutOf(await repoOf("epics", epicId));
      const result = await publishEpicBranch({ git: processGitCommand, repositoryPath, epicId });
      // Recorded here, not at the first merge: the freshness pass reads this
      // column to decide what to keep close to main, and a branch its Stories
      // are already being written against is exactly what has to be kept.
      await store.recordIntegrationBranch(epicId, result.branch);
      if (result.pushed) console.log(`Published ${result.branch} to origin`);
    } catch (error) {
      console.error(`Publishing epic/${epicId} failed; delivery will retry before the first Story worktree is cut:`, (error as Error).message);
    }
  };
  const providerHealth = new LibsqlProviderHealthStore(handle.client);
  const piBinary = defaultPiBinary();
  const credentialFilePath = join(homedir(), ".pi", "agent", "auth.json");
  const credentialLockPath = join(homedir(), ".hivemind", "auth-refresh.lock");
  const modelCatalog = defaultModelCatalog(piBinary);
  const modelPolicy = new ModelPolicy(config, modelCatalog);
  /**
   * The one variable an API-key provider's pi spawn needs. systemd hands the
   * daemon its `EnvironmentFile`, but a run by hand inherits nothing, and pi
   * then reports the provider as unconfigured — indistinguishable from a key
   * nobody ever added. An OAuth provider keeps its credential in pi's auth
   * file and gets nothing here.
   */
  const providerEnvFor = async (provider: string): Promise<Record<string, string>> => {
    const profile = await modelPolicy.profileOf(provider);
    // The cache window belongs to every spawn, credentialed or not.
    const cacheEnv = cacheRetentionEnv(config);
    if (!needsApiKeyEnv(profile)) return cacheEnv;
    return { ...cacheEnv, ...providerKeyEnv({
      provider,
      ...(profile.envKey ? { envKey: profile.envKey } : {}),
      secrets: stored,
      secretsPath,
    }) };
  };
  await assertOutOfBandChannel(alerts, config);
  await assertProviderRetriesDisabled(config);
  // A refresher that rotates less often than one prompt may run leaves a phase
  // able to outlive its own credential.
  assertCredentialRefreshCoverage({
    credentialRefreshIntervalMs: config.get("provider.credentialRefreshIntervalMs"),
    promptTimeoutMs: config.get("retry.promptTimeoutMs"),
  });
  await assertModelPolicy(config, modelCatalog);
  // A provider whose failure wordings were never captured would have its quota
  // message read as UNKNOWN, and the card would take the wrong recovery path.
  assertErrorFixtureCoverage(config.get("model.failoverChain"));
  const storyApi = new NotionGatewayStoryApi(gateway);
  const botUserId = stored.get("NOTION_BOT_USER_ID");
  const comments = new CommentIngestor(
    handle.client,
    new NotionGatewayCommentSource(gateway),
    {
      users: new NotionUserDirectory(handle.client, gateway),
      ...(botUserId ? { botUserId } : {}),
    },
  );
  const inputSync = new NotionStoryInputSync(handle.client, gateway, storyApi, comments, store);
  const approvalJudge = approvalJudgeSetup(judgeConfigFrom(config), stored);
  const epicInputSync = new NotionEpicInputSync(
    handle.client,
    gateway,
    comments,
    new PlanApprovalStore(handle.client, Date.now, {
      limits: { maxStories: config.get("decompose.maxStoriesPerEpic") },
      planApproval: config.get("decompose.planApproval"),
      onApproved: publishEpicBranchFor,
    }),
    Date.now,
    undefined,
    approvalJudge.settings,
    (input) => store.recordFriction(input),
  );
  const media = new NotionMediaReconciler(
    handle.client,
    new NotionMediaPipeline(new NotionGatewayMediaPort(gateway)),
    { onError: (error) => console.error("Notion media delivery failed:", (error as Error).message) },
  );
  const outbox = new NotionOutbox(handle.client);
  // The console's write: a decision on a todo the ledger already says is
  // waiting. It shares this outbox; each operation replays only its own rows.
  const todoDecisionDrain = createTodoDecisionDrain({
    client: handle.client,
    outbox,
    delivery: createTodoDecisionDelivery({ gateway }),
  });
  const todoDecisionStore = createTodoDecisionStore({
    client: handle.client,
    outbox,
    drain: todoDecisionDrain,
  });
  const todoReadPort: ConsoleTodoReadPort = {
    listTodos: async () => {
      const todos = await listPendingTodos(handle.client);
      return { todos, openTodoId: todos[0]?.todoId ?? null };
    },
    readTodo: (todoId) => readPendingTodo(handle.client, todoId),
  };
  const projection = new NotionStoryProjection(handle.client);
  const delivery = new NotionStoryDelivery(
    new NotionStoryPageDelivery(handle.client, gateway),
    new NotionStoryPropertyDelivery(gateway, handle.client),
    new NotionEpicPlanDelivery(gateway, handle.client, dataSourceId),
  );

  let coordinator: NotionSyncCoordinator;
  const registerActiveStories = async (): Promise<void> => {
    // Approval and blocking-question answers both arrive as Epic-page comments.
    const epics = (await handle.client.execute({
      sql: `SELECT id, notion_page_id FROM epics
            WHERE state IN ('PLAN_APPROVAL', 'BLOCKED', 'EPIC_ACCEPT') ORDER BY id`,
    })).rows;
    for (const epic of epics) {
      const pageId = String(epic.notion_page_id);
      // A comment on an acceptance box says what that scenario is missing, so
      // the boxes are anchors like any other block a person writes under.
      const boxes = (await handle.client.execute({
        sql: `SELECT notion_block_id FROM epic_acceptance_items
              WHERE epic_id = ? AND notion_block_id IS NOT NULL`,
        args: [String(epic.id)],
      })).rows.map((row) => String(row.notion_block_id));
      await comments.registerPage(pageId, boxes);
      coordinator.registerActivePage(pageId);
    }
    const stories = (await handle.client.execute({
      // A Story whose page is still queued for creation only has a synthetic id;
      // polling it would 404 every round.
      sql: `SELECT id, notion_page_id FROM stories s
            WHERE state NOT IN ('DELIVERED', 'FAILED')
              AND NOT EXISTS (SELECT 1 FROM notion_outbox o
                              WHERE o.card_id = s.id AND o.operation = 'create_story_page' AND o.state = 'pending')
            ORDER BY id`,
    })).rows;
    for (const story of stories) {
      const cardId = String(story.id);
      const pageId = String(story.notion_page_id);
      const anchors = (await handle.client.execute({
        sql: `SELECT anchor_block_id AS block_id FROM notion_sections WHERE story_id = ?
              UNION SELECT notion_block_id AS block_id FROM story_specs
                    WHERE story_id = ? AND notion_block_id IS NOT NULL`,
        args: [cardId, cardId],
      })).rows.map((row) => String(row.block_id));
      await comments.registerPage(pageId, anchors);
      coordinator.registerActivePage(pageId);
    }
  };
  /** Sends what is queued for the Story side. The requirement loop shares this
   * outbox; each side replays only its own rows. */
  const sendQueuedNotionWrites = async (): Promise<void> => {
    const replayed = await outbox.replay(delivery, {
      operations: STORY_OUTBOX_OPERATIONS,
      wholeStateOperations: STORY_WHOLE_STATE_OPERATIONS,
    });
    for (const row of replayed.superseded) {
      console.log(`Notion outbox: dropped a stale ${row.operation} for ${row.cardId ?? "no card"} after ${row.attempts} attempts; the page already holds a newer one`);
    }
    for (const failure of replayed.failures) {
      console.warn(`Notion outbox: ${failure.operation} for ${failure.cardId ?? "no card"} failed (attempt ${failure.attempts}): ${failure.error}`);
    }
    for (const letter of replayed.dead) {
      await reportP0(
        `Notion outbox gave up on ${letter.operation} for ${letter.cardId ?? "no card"}`,
        new Error(`${letter.attempts} attempts; last error: ${letter.lastError ?? "unknown"}`),
      );
    }
  };

  const syncIntake = async (): Promise<void> => {
    await ingestReadyStories(storyApi, dataSourceId, store);
    await registerActiveStories();
  };
  const reconcileProjection = async (): Promise<void> => {
    // A parked Story is the Epic's problem too: the board shows the Epic as
    // blocked while any of its Stories waits for a person, and executing again
    // once none does.
    for (const change of await escalateParkedStories(handle.client)) {
      console.warn(`Epic ${change.epicId} ${change.kind}: Stories ${change.storyIds.join(", ")}`);
    }
    await surfaceBlockedEpics(handle.client);
    // The Epic page is where a person sees the review request and each
    // Story's state; it is derived from the database every cycle and only
    // travels when something on it changed.
    await enqueueEpicPages(handle.client, boardTargetBranch);
    const stories = (await handle.client.execute("SELECT id FROM stories ORDER BY id")).rows;
    for (const story of stories) await projection.enqueue(String(story.id));
    await sendQueuedNotionWrites();
    // The todo decision writes are their own operation; the cycle carries them
    // the same way it carries the page projections, so a decision submitted
    // while the console was up is delivered even if nobody opens the page again.
    await todoDecisionDrain.drain();
    await media.reconcile();
    await registerActiveStories();
  };
  // Two callers reconcile: a Story subprocess finishing, and the timed cycle.
  // They are allowed to coincide, and the second one wants the first one's
  // result rather than a second pass over the same rows, so it joins the run
  // already in flight. Without this the two passes claim rows from each other
  // and every projection does its own extra round trip to Notion.
  let reconciling: Promise<void> | null = null;
  const reconcileProjections = async (): Promise<void> => {
    reconciling ??= reconcileProjection().finally(() => { reconciling = null; });
    await reconciling;
  };
  // Archived or deleted pages must not spin the fallback poller forever: a
  // 404 drops the page from the active set instead of surfacing as an error.
  const pollOnce = async (pageId: string, attempt: () => Promise<unknown>): Promise<void> => {
    try {
      await attempt();
    } catch (error) {
      if (error instanceof NotionGatewayError && error.status === 404) {
        coordinator.unregisterActivePage(pageId);
        console.warn(`Notion page ${pageId} is gone; dropped from the sync active set`);
        return;
      }
      throw error;
    }
  };
  const isEpicPage = async (pageId: string): Promise<boolean> => {
    const row = (await handle.client.execute({
      sql: "SELECT 1 FROM epics WHERE notion_page_id = ?",
      args: [pageId],
    })).rows[0];
    return row !== undefined;
  };
  const poller: NotionSyncPoller = {
    pollProperties: async (pageId) => {
      await syncIntake();
      await pollOnce(pageId, async () => {
        if (await isEpicPage(pageId)) await epicInputSync.pollProperties(pageId);
        else await inputSync.pollProperties(pageId);
      });
    },
    pollContent: async (pageId) => {
      await syncIntake();
      await pollOnce(pageId, async () => {
        if (await isEpicPage(pageId)) await epicInputSync.pollContent(pageId);
        else await inputSync.pollContent(pageId);
      });
    },
    pollComments: async (pageId) => {
      await pollOnce(pageId, async () => {
        if (await isEpicPage(pageId)) await epicInputSync.pollComments(pageId);
        else await inputSync.pollComments(pageId);
      });
    },
  };
  coordinator = new NotionSyncCoordinator(poller, {
    intervalMs: 60_000,
    onError: (error) => console.error("Notion fallback poll failed:", (error as Error).message),
  });

  let running = false;
  // One line, not one per cycle.
  let reportedNoBoardRepository = false;
  // Epics waiting to be split are the only source of new Stories; without this
  // the approval gate has nothing to gate and the board's Epics never move.
  const decomposeWaitingEpic = async (): Promise<void> => {
    if (!epicsDataSourceId) return;
    // An Epic written straight on the board carries no repository of its own.
    // With one registered there is nothing to choose; with several, guessing
    // would decompose somebody's work against the wrong tree, so the card waits
    // for a requirement (which does carry one) or for a person.
    const boardRepository = servable.length === 1 ? servable[0]!.slug : null;
    if (!boardRepository && !reportedNoBoardRepository) {
      reportedNoBoardRepository = true;
      console.log("Epics created on the board are left alone: this installation serves more than one repository");
    }
    const waiting = boardRepository
      ? await ingestEpicsForDecomposition(handle.client, gateway, epicsDataSourceId, boardRepository)
      : [];
    const pending = (await handle.client.execute(
      "SELECT id FROM epics WHERE state IN ('INTAKE', 'DECOMPOSE') ORDER BY updated_at",
    )).rows;
    // Oldest first, but an Epic the board did not hand back must not hold up
    // the ones behind it. Intake skips an Epic whose page has no body, and any
    // Epic whose status column has moved on is not in the query it answers;
    // taking only the first row from the database would then pick that same
    // Epic every cycle and decompose nothing, with nothing logged.
    const epic = pending
      .map((row) => waiting.find((candidate) => candidate.id === String(row.id)))
      .find((candidate) => candidate !== undefined);
    if (!epic) return;

    const chain = providerOverride ? [providerOverride] : await modelPolicy.providersFor("decompose");
    const healths = await providerHealth.snapshot();
    const provider = usableProviders(chain, healths, Date.now())[0];
    if (!provider) {
      console.warn(`no provider can decompose ${epic.id} right now`);
      return;
    }
    const epicSlug = await repoOf("epics", epic.id);
    const epicConfig = await configFor(epicSlug);
    const repositoryPath = checkoutOf(epicSlug);
    const repositoryId = repositoryIdFor(epicSlug);
    const capturePath = laneCapturePath(join(workRoot, "evidence", repositoryId), "decompose", Date.now());
    // The tree the split is read from has to be the tree it will be built in.
    await ensureCheckout({
      url: (await repositories.get(epicSlug))!.remoteUrl,
      slug: epicSlug,
      defaultBranch: (await repositories.get(epicSlug))!.defaultBranch,
      workRoot,
    }, { refresh: true });
    await config.reload();
    const decompositionLimits = { maxStories: epicConfig.get("decompose.maxStoriesPerEpic") };
    const decomposer = new EpicDecomposer(
      handle.client,
      new PlanApprovalStore(handle.client, Date.now, {
        limits: decompositionLimits,
        planApproval: epicConfig.get("decompose.planApproval"),
        onApproved: publishEpicBranchFor,
      }),
      new PiDecomposePort({
        binary: piBinary,
        spec: await resolveAgentSpec({ config: epicConfig, policy: modelPolicy }, "decompose", provider),
        // The requirement lane spends on the brain tier; without this its cost
        // is simply missing, and a card's bill reads as the execution half
        // only.
        recordUsage: async ({ usage, spec }) => {
          await new CostLedger(handle.client).record({
            runId: `decompose-${epic.id}-${Date.now()}`,
            cardId: epic.id,
            purpose: "decompose",
            tier: spec.tier,
            provider: spec.model.provider,
            modelId: spec.model.id,
            hostId: hostname(),
            isSubscription: !spec.metered,
          }, usage);
        },
        env: {
          ...(await providerEnvFor(provider)),
          // The exact request this lane sent, captured the same way the Story
          // phases capture theirs: a requirement that produced a bad split is
          // unanswerable without the prompt that produced it.
          [CANONICAL_CAPTURE_ENV]: capturePath,
        },
        extensions: [join(ROOT, "extensions", "canonical-capture.ts")],
        promptRoot: join(ROOT, "prompts"),
        cwd: repositoryPath,
        contextFiles: await repositoryContextFiles(repositoryPath),
        guard: {
          extension: join(ROOT, "extensions", "hive-guard.ts"),
          auditPath: join(workRoot, "evidence", repositoryId, "decompose-tool-audit.jsonl"),
        },
      }),
      Date.now,
      decompositionLimits,
      {
        language: businessLanguageJudgeSetup(judgeConfigFrom(epicConfig), stored).settings,
        slice: verticalSliceJudgeSetup(judgeConfigFrom(epicConfig), stored).settings,
        recordFriction: (input) => store.recordFriction(input),
      },
    );
    // The provider was chosen from the breaker but nothing here reported back
    // to it, so a spent account stayed "usable" and every cycle spawned into
    // the same refusal. Only a failure the error catalogue recognises says
    // anything about the provider: a defect of ours is UNKNOWN and must not
    // open a breaker. With this written down, the next cycle skips the open
    // provider and takes the next one in the chain.
    try {
      const outcome = await decomposer.decompose(epic).catch(async (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (classifyError(message).class !== "UNKNOWN") {
          await providerHealth.recordFailure(provider, message, await breakerPolicy(epicConfig))
            .catch(() => undefined);
        }
        throw cause;
      });
      console.log(`Epic ${epic.id} decomposition: ${outcome.kind}`);
      if (outcome.kind !== "presented") {
        await alerts.send({
          kind: "needs_input",
          title: `Epic ${epic.id} cannot be decomposed`,
          body: outcome.kind === "blocking_question" ? outcome.question.question : outcome.reasons.join("; "),
        }).catch((cause: unknown) => console.error("alert failed:", (cause as Error).message));
      }
    } finally {
      await finishLaneCapture(capturePath);
    }
  };

  let lastP0 = "";
  let lastP0At = 0;
  const reportP0 = async (title: string, error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : title;
    const time = Date.now();
    // One line per distinct failure per ten minutes: a provider outage would
    // otherwise page the operator once per cycle.
    if (message === lastP0 && time - lastP0At < 10 * 60_000) return;
    lastP0 = message;
    lastP0At = time;
    if (alerts.channelCount === 0) {
      console.error(`P0: ${title} (no out-of-band alert channel):`, message);
      return;
    }
    const delivered = await alerts.send({ kind: "p0", title, body: message });
    if (delivered.delivered.length === 0) {
      console.error("P0 alert failed on every channel:", JSON.stringify(delivered.failed));
    }
  };

  /**
   * Background work whose failure is reported rather than raised, and only
   * when somebody has to look at it.
   *
   * Two questions, not one. `step` already skips a fault that retrying clears,
   * but an inner catch that reports first never lets it: a Notion request that
   * hit its deadline during decomposition paged the operator about a request
   * the next cycle would have made successfully. So the classifier is asked
   * whether a person is needed -- which it answers yes to for anything it does
   * not recognise -- and only then is the page sent; everything else is a line
   * in the log and another try next cycle.
   */
  const reportedStep = async (name: string, run: () => Promise<void>): Promise<void> =>
    step(name, async () => {
      try {
        await run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!classifyError(message).needsHuman) {
          console.warn(`${name} was skipped this cycle: ${message}`);
          return;
        }
        await reportP0(`${name} failed`, error);
      }
    });

  const inFlight = new Map<string, Promise<void>>();
  const storyChildren = new Set<ChildProcess>();
  // Set the moment shutdown starts. The signal reaches the whole process group,
  // so a Story's pi dies of it too, and the error that surfaces here is
  // whatever pi was in the middle of -- no signal of our own to read. Without
  // this every restart charges every in-flight card one of its three attempts.
  let stopping = false;

  // The coordinator hands over a card and its paths, nothing else: which
  // provider, model, tier and reasoning effort a phase runs on is resolved by
  // the subprocess, per phase, from the same configuration every other lane
  // reads. Passing a model on the command line is what silently dropped the
  // reasoning effort and ran every phase of a card on the CODE tier.
  const runStory = async (cardId: string, row: Row): Promise<void> => {
      // A Story the approval gate created has no branch yet: the cut is delayed
      // until its dependencies are on the Epic head, which is where the branch
      // has to start from.
      if (!row.branch && row.epic_id) {
        const claim = await new IntegrationDispatchStore(handle.client)
          .claimStart(cardId, `story/${cardId.toLowerCase()}`);
        if (claim.kind === "blocked") {
          console.log(`Story ${cardId} waits for ${claim.waitingFor.join(", ")}`);
          return;
        }
        const claimed = (await handle.client.execute({
          sql: "SELECT branch, target_branch FROM stories WHERE id = ?",
          args: [cardId],
        })).rows[0];
        row = { ...row, branch: claimed?.branch ?? null, target_branch: claimed?.target_branch ?? null } as Row;
      }
      if (!row.branch) throw new Error(`Story ${cardId} does not declare a branch`);
      const branch = String(row.branch);
      const targetBranch = row.target_branch ? String(row.target_branch) : "main";
      if (!row.repo) throw new Error(`Story ${cardId} does not declare a repository`);
      const slug = String(row.repo);
      const repositoryPath = checkoutOf(slug);
      const repositoryId = repositoryIdFor(slug);
      const targetBranchDefault = (await repositories.get(slug))?.defaultBranch ?? "main";
      const layout = worktreeLayout(workRoot);
      // A Story inside an Epic lands on the Epic branch, which needs a worktree
      // of its own: the Story's own worktree is mid-rebase during the merge.
      // The Epic branch is also the Story branch's start point, so it has to
      // exist before the Story worktree is cut.
      const epicId = String(row.epic_id ?? "");
      let integrationWorktree: string | null = null;
      if (epicId) {
        const integrationCard = `epic-${epicId}`;
        const epicBranch = `epic/${epicId}`;
        // Normally already done at approval; this is the retry for an approval
        // whose push failed, and it must succeed before a Story stacks on it.
        const published = await publishEpicBranch({ git: processGitCommand, repositoryPath, epicId });
        await store.recordIntegrationBranch(epicId, published.branch);
        let integration = locateWorktree(repositoryId, integrationCard, layout);
        if (!(await exists(integration.worktreePath))) {
          integration = await createWorktree({
            repositoryPath,
            repositoryId,
            cardId: integrationCard,
            branch: epicBranch,
            startPoint: targetBranch === epicBranch ? targetBranchDefault : targetBranch,
          }, layout);
          // The integration tree runs the merge checks, so it needs the same
          // preparation the Story tree does.
          await prepareWorktree(integration.worktreePath, slug);
        }
        integrationWorktree = integration.worktreePath;
      }
      let location = locateWorktree(repositoryId, cardId, layout);
      if (!(await exists(location.worktreePath))) {
        location = await createWorktree({
          repositoryPath,
          repositoryId,
          cardId,
          branch,
          startPoint: targetBranch,
        }, layout);
        await prepareWorktree(location.worktreePath, slug);
      } else if (await currentBranch(location.worktreePath) !== branch) {
        throw new Error(`existing worktree for ${cardId} is not on ${branch}`);
      }
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      let result;
      try {
        const pending = execFileAsync(npm, [
          "run", "story:run", "--",
          "--card-id", cardId,
          "--worktree", location.worktreePath,
          "--evidence-root", location.evidencePath,
          "--session-root", join(workRoot, "sessions", repositoryId, cardId),
          "--target-branch", targetBranch,
          ...(integrationWorktree ? ["--integration-worktree", integrationWorktree] : []),
          ...(await repositoryContextFiles(location.worktreePath))
            .flatMap((file) => ["--context", `${file.label}=${file.path}`]),
        ], {
          cwd: ROOT,
          windowsHide: true,
          // Windows refuses to spawn .cmd shims without a shell (EINVAL).
          shell: process.platform === "win32",
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, HIVEMIND_DB_URL: dbUrl },
        });
        // Held so a shutdown can stop waiting for it. Without a handle the
        // only way out of a drain was to wait for a whole inner loop.
        storyChildren.add(pending.child);
        try {
          result = await pending;
        } finally {
          storyChildren.delete(pending.child);
        }
      } catch (error) {
        // What a dead run costs the card is one decision, taken in
        // `decideDispatchFailure`: a run this process killed and a run a
        // provider killed both say nothing about whether the work can be done,
        // and only the last two outcomes charge anything. The reason is
        // written to the card either way, because a card that stops here has
        // nothing else recorded against it.
        // This card has no live run now, so every capture under it is
        // finished. A run that died never reached `writeEvidence`, so nothing
        // else will ever fold these into a log or pack them, and they are the
        // only record of what that run sent -- 405MB of them had accumulated.
        await packFinishedCaptures(location.evidencePath).catch(() => 0);
        const decision = await settleDispatchFailure({ store, config, cardId, error, stopping });
        switch (decision.kind) {
          case "cancelled":
            console.warn(`Story ${cardId} run was cancelled by this shutdown; it keeps its reentry budget`);
            return;
          case "host_fault":
            // Loud, and free for the card. Nothing it did produced this and
            // the next attempt would meet the same broken host, so the budget
            // is left alone and a person is told once per attempt instead.
            await reportP0(`this host cannot run a Story (${cardId} never started)`, error);
            return;
          case "provider_fault":
            // The breaker's own "intake halted" line is the alert for this; a
            // P0 per attempt would repeat it for every card on every retry.
            console.warn(`Story ${cardId} attempt ended on a ${decision.errorClass} provider fault; it waits for the breaker`);
            return;
          case "ignored":
            break;
          case "reenter":
            // Same reason as a provider fault: the card keeps its budget and
            // this host runs it again on its own. The warn line and the durable
            // story.dispatch_failed event are the record, and the alert comes
            // when the budget runs out below. A CODE exit that spends its
            // rounds is an ordinary refusal, and it raised one P0 per attempt.
            console.warn(`Story ${cardId} will re-enter ${decision.state} (attempt ${decision.attempt}/${decision.budget})`);
            return;
          case "park":
            console.warn(`Story ${cardId} parked after ${decision.attempt} failed attempt(s) in ${decision.state}`);
            // This is the alert for a parked card: one summary, to every sink.
            // Raising P0 as well sent a second one carrying the subprocess
            // command line, which says less and arrives after it.
            await announceStop(cardId);
            return;
        }
        throw error;
      }
      if (result.stdout.trim()) console.log(result.stdout.trim());
      await reconcileProjections();
      const completed = await store.getStory(cardId);
      if (completed.state === "NEEDS_INPUT") await announceStop(cardId);
      // Delivered means the work is on the Epic branch, so this tree is spare.
      // It is a full checkout with the repository's dependencies in it, and
      // keeping every one of them is how the work root reached 3.1GB of trees.
      if (completed.state === "DELIVERED" && await retireWorktree(repositoryPath, location.worktreePath)) {
        console.log(`Retired the worktree for ${cardId}; its branch keeps every commit`);
      }
  };

  // Everything that wants to know a card stopped hears the same summary: the
  // console, the out-of-band alert, and the friction record the reflection
  // pipeline reads. They used to be three independent renderings of a history
  // only one of them could see.
  const stopSinks: StoryStopSink[] = [
    new AlertStopSink(alerts),
    new FrictionStopSink({ record: (input) => store.recordFriction(input) }),
  ];
  const announceStop = async (cardId: string): Promise<void> => {
    const summary = await store.stopSummary(cardId);
    if (!summary) return;
    // The board is the fourth listener, and the only one a person actually
    // looks at. Refreshing it lived on the path a run takes when it succeeds,
    // so a card parked by a dead run kept its page reading "进行中" and "现在
    // 没有等你处理的事" until a later cycle got round to projecting -- behind
    // decomposition, Epic upkeep and a full regression sweep, which is half an
    // hour on this host. A stop nobody is told about is not a stop for a
    // person, it is a halt.
    await reconcileProjections().catch((error: unknown) => {
      console.error(`Story ${cardId} stopped but its page could not be refreshed: ${(error as Error).message}`);
    });
    console.warn(renderStopSummary(summary));
    const { failed } = await notifyStoryStopped(stopSinks, summary);
    for (const failure of failed) console.error(`Story ${cardId} stopped but a sink refused it: ${failure}`);
  };

  // The platform CLI is looked up once; an Epic that reaches review with no
  // CLI on the host is a deployment defect, reported by the cycle's P0 path.
  let mrPort: Awaited<ReturnType<typeof discoverMRPort>> | undefined;
  const mergeRequests = async () => (mrPort ??= await discoverMRPort());

  // An Epic that is fully integrated has one review request to open, an Epic
  // whose review request has landed is finished, and an Epic that is still
  // executing has to keep up with main.
  const maintainEpics = async (): Promise<void> => {
    const layout = worktreeLayout(workRoot);
    await config.reload();

    // A split this system's own checks refused is not a question anybody can
    // answer, so it must not be left waiting for a comment. The revision of
    // the running installation is what identifies the criteria: when it moves,
    // every such refusal is stale and its Epic gets one more attempt.
    for (const epicId of await reopenRejectedDecompositions({
      client: handle.client,
      criteriaVersion: await installedRevision(),
    })) {
      console.log(`Epic ${epicId} goes back to decomposition: the criteria that refused it have changed`);
    }

    // Which repository each Epic belongs to, read once: every path below is
    // derived from it, and an Epic is not moved between repositories.
    const epicRepositories = new Map((await handle.client.execute("SELECT id, repo FROM epics")).rows
      .map((row) => [String(row.id), String(row.repo ?? "")]));
    const slugOfEpic = (epicId: string): string => epicRepositories.get(epicId) || servable[0]!.slug;
    // Which repository a worktree belongs to, so a check run in it reads that
    // repository's own declared commands.
    const owners = new Map<string, string>();
    const epicWorktree = (epicId: string): string => {
      const slug = slugOfEpic(epicId);
      const path = locateWorktree(repositoryIdFor(slug), `epic-${epicId}`, layout).worktreePath;
      owners.set(path, slug);
      return path;
    };
    const freshness = new EpicBranchFreshness(handle.client, {
      worktreePath: epicWorktree,
      intervalMs: config.get("schedule.epicBranchFreshnessMs"),
    });
    for (const result of await freshness.tick()) {
      if (result.outcome === "failed") {
        console.warn(`Epic ${result.epicId} branch refresh failed: ${result.reason}`);
      }
    }

    // An Epic head that failed a check is usually repaired somewhere else
    // entirely - on main, in another Epic, or by hand on the host - so nothing
    // announces the fix and somebody has to look again.
    for (const outcome of await recheckEpicHeads({
      client: handle.client,
      checks: {
        run: async (check, cwd) => {
          const scoped = await configFor(owners.get(cwd) ?? servable[0]!.slug);
          const declared = scoped.get("codeExit.projectChecks").find((entry) => entry.name === check);
          if (!declared) return { passed: false, detail: `the repository no longer declares a check named ${check}` };
          return runProjectCheck(cwd, declared);
        },
      },
      worktreePath: epicWorktree,
      headSha: async (epicId) => (await processGitCommand.run(
        epicWorktree(epicId),
        ["rev-parse", "HEAD"],
      )).trim(),
      intervalMs: config.get("regression.epicPoolIntervalMs"),
    })) {
      if (outcome.outcome === "recovered") console.log(`Epic ${outcome.epicId} head is green again; it continues`);
      if (outcome.outcome === "still_failing") {
        console.warn(`Epic ${outcome.epicId} head still fails: ${outcome.failures.join(", ")}`);
      }
    }

    // A finished Epic's trees are spare. Its scenarios move to the main pool,
    // which sweeps `regression-main` and needs no probe at all, and its
    // integration tree has no Story left to take. Both are a full checkout
    // with the repository's dependencies in them -- 336MB per Epic here -- and
    // `createWorktree` puts either back from its branch if a delivered card is
    // ever reopened.
    const retireEpicTrees = async (epicId: string): Promise<void> => {
      const slug = slugOfEpic(epicId);
      const repository = checkoutOf(slug);
      for (const name of [`epic-${epicId}`, `probe-${epicId}`]) {
        const path = locateWorktree(repositoryIdFor(slug), name, layout).worktreePath;
        if (await retireWorktree(repository, path)) console.log(`Retired the worktree ${name}`);
      }
    };
    for (const outcome of await new EpicCompletion(handle.client, await mergeRequests()).tick()) {
      if (outcome.kind === "done") {
        console.log(`Epic ${outcome.epicId} is done: its review request landed`);
        await retireEpicTrees(outcome.epicId);
      }
      if (outcome.kind === "gap") {
        console.log(`Epic ${outcome.epicId} goes back to work: ${outcome.storyIds.join(", ")} carry what acceptance found missing`);
      }
      if (outcome.kind === "unreadable") console.warn(`Epic ${outcome.epicId} review state unreadable: ${outcome.reason}`);
    }

    const finished = (await handle.client.execute({
      sql: `SELECT e.id FROM epics e
             WHERE e.state = 'EXECUTING'
               AND EXISTS (SELECT 1 FROM stories WHERE epic_id = e.id)
               AND NOT EXISTS (
                 SELECT 1 FROM stories s
                   LEFT JOIN execution_dispatches d ON d.story_id = s.id
                  WHERE s.epic_id = e.id
                    AND (s.state <> 'DELIVERED' OR d.state IS NOT 'integrated')
               )
             ORDER BY e.updated_at LIMIT 1`,
    })).rows[0];
    if (!finished) return;
    const epicId = String(finished.id);
    const worktreePath = epicWorktree(epicId);
    const targetBranchDefault = (await repositories.get(slugOfEpic(epicId)))?.defaultBranch ?? "main";
    // An Epic whose review request cannot be opened must not take the rest of
    // the cycle down with it: every other Story would stop being dispatched
    // for a reason that has nothing to do with them.
    let delivered;
    try {
      delivered = await new EpicMrDelivery(handle.client, await mergeRequests(), {
        worktreePath,
        targetBranch: targetBranchDefault,
        regressionClean: (id, revision) => epicRegressionClean(handle.client, id, revision),
      }).deliver(epicId);
    } catch (error) {
      await reportP0(`Epic ${epicId} review request could not be opened`, error);
      return;
    }
    if (delivered.kind === "waiting") {
      console.log(`Epic ${epicId} review request waits: ${delivered.reason}`);
      return;
    }
    await handle.client.execute(epicTransitionStatement({
      epicId, from: "EXECUTING", to: "EPIC_ACCEPT", at: Date.now(), set: { mrUrl: delivered.mrUrl },
    }));
    // The batch is complete, so what it promised goes up for judgement on its
    // own page, next to the review request that carries it.
    const judged = await new EpicAcceptance(handle.client).open(epicId);
    if (judged.length > 0) console.log(`Epic ${epicId} acceptance: ${judged.length} scenarios to judge`);
    // Said once, where a person is being asked to judge this batch: a card no
    // sweep can close is not holding the review request -- the gate reaches
    // cards through the registry, and an orphan has no row there -- but it is
    // still open, and whoever accepts the Epic is the one who can decide
    // whether the lane it moved to actually proves it. Recorded as an event as
    // well as logged, because a log tail is not somewhere a decision waits.
    const orphans = await readOrphanedCards(handle.client, { epicId });
    for (const card of orphans) console.log(`Epic ${epicId}: ${describeOrphanedCard(card)}`);
    if (orphans.length > 0) {
      const runId = `epic-acceptance:${epicId}`;
      await handle.client.execute({
        sql: `INSERT INTO event_log (run_id, seq, card_id, phase, type, ts, data)
              VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM event_log WHERE run_id = ?), ?, NULL,
                      'regression.orphaned_cards', ?, ?)`,
        args: [runId, runId, epicId, Date.now(), JSON.stringify({
          cards: orphans.map((card) => ({
            scenarioId: card.scenarioId,
            attributedStory: card.attributedStory,
            layers: card.layers,
          })),
        })],
      });
    }
    console.log(`Epic ${epicId} review request: ${delivered.mrUrl}`);
  };

  // The resident E2E loop. It only ever polls when this host has no Story in
  // flight; a merge invalidates its Epic's scenarios, which is what turns an
  // integration into an immediate sweep rather than an event queue.
  const registry = new ScenarioRegistry(handle.client);
  /** One sweep per cycle, in whichever repository has work for it first. */
  const regressionSweep = async (): Promise<void> => {
    for (const repository of servable) {
      if (await sweepRepository(repository.slug, repository.defaultBranch)) return;
    }
  };
  const sweepRepository = async (slug: string, targetBranchDefault: string): Promise<boolean> => {
    const repositoryId = repositoryIdFor(slug);
    const repositoryPath = checkoutOf(slug);
    await config.reload();
    // Scenarios an Epic's review request is waiting on. Without this the gate
    // asks for evidence that only an idle host would ever produce, and a
    // delivered Epic could sit behind another Epic's Story indefinitely.
    // Asked at the revision the request would propose, which is the question
    // the gate itself asks: "has it ever passed" let every scenario whose Epic
    // head had since moved drop out of this set and wait for an idle host.
    const awaitedByDelivery: string[] = [];
    for (const epicId of await epicsAwaitingDelivery(handle.client, slug)) {
      // No branch means nothing was ever published for this Epic, so there is
      // no revision to prove anything at; the idle sweep still covers it.
      const head = await processGitCommand
        .run(repositoryPath, ["rev-parse", `epic/${epicId}`])
        .then((sha) => sha.trim())
        .catch(() => "");
      if (head === "") continue;
      awaitedByDelivery.push(...await scenariosAwaitingDelivery(handle.client, epicId, head));
    }

    const plan = planRegressionSweep({
      now: Date.now(),
      foregroundBusy: inFlight.size > 0,
      epicScenarios: await registry.pool("epic", slug),
      mainScenarios: await registry.pool("main", slug),
      triggered: awaitedByDelivery,
      policy: {
        epicPoolIntervalMs: config.get("regression.epicPoolIntervalMs"),
        mainPoolIntervalMs: config.get("regression.mainPoolIntervalMs"),
        batchSize: config.get("regression.batchSize"),
      },
    });
    if (!plan) return false;

    const layout = worktreeLayout(workRoot);
    const epicId = plan.pool === "epic"
      ? (await registry.pool("epic", slug)).find((scenario) => plan.scenarioIds.includes(scenario.scenarioId))?.epicId ?? null
      : null;
    const sweepCard = plan.pool === "epic" && epicId ? `epic-${epicId}` : "regression-main";
    const branch = plan.pool === "epic" && epicId ? `epic/${epicId}` : targetBranchDefault;
    let sweepTree = locateWorktree(repositoryId, sweepCard, layout);
    if (!(await exists(sweepTree.worktreePath))) {
      sweepTree = await createWorktree({
        repositoryPath,
        repositoryId,
        cardId: sweepCard,
        branch,
        startPoint: targetBranchDefault,
      }, layout);
      await prepareWorktree(sweepTree.worktreePath, slug);
    }

    // Attribution bisects the Epic's Story sequence by checking out revisions,
    // which detaches HEAD; the sweep tree keeps its branch, so the probe needs
    // a tree of its own.
    let probeWorktree: string | null = null;
    if (epicId) {
      let probeTree = locateWorktree(repositoryId, `probe-${epicId}`, layout);
      if (!(await exists(probeTree.worktreePath))) {
        probeTree = await createWorktree({
          repositoryPath,
          repositoryId,
          cardId: `probe-${epicId}`,
          branch: `probe/${epicId}`,
          startPoint: branch,
        }, layout);
        await prepareWorktree(probeTree.worktreePath, slug);
      }
      probeWorktree = probeTree.worktreePath;
    }

    // How much else this host was driving when the sweep started, read before
    // the spawn because dispatch moves on while the sweep runs.
    const foreground = inFlight.size;
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // A sweep is one whole unit of work, and it walks the chain like every
    // other unit: the provider that refused it is stepped over rather than
    // ending the sweep for the cycle. It used to be pinned to the first healthy
    // provider, which is the one arrangement in the system with no failover at
    // all -- measured on 2026-09-19/20, seventeen cycles across three Epics were
    // skipped on one transient "upstream model provider is temporarily
    // unavailable" from the first provider, which kept serving cards and so kept
    // its breaker closed and was chosen again the next cycle. A sweep that
    // cannot run is not background hygiene -- an Epic whose Stories have all
    // landed cannot open its review request until its scenarios pass, so this
    // is the thing standing between the requirement and delivery.
    let result;
    try {
      result = await runWithFailover("verify", async (model) => execFileAsync(npm, [
        "run", "regression:run", "--",
        "--pool", plan.pool,
        "--branch", branch,
        "--worktree", sweepTree.worktreePath,
        "--scenarios", plan.scenarioIds.join(","),
        "--repository", slug,
        "--evidence-root", join(workRoot, "evidence", repositoryId, sweepCard),
        "--provider", model.provider,
        "--model", modelOverride ?? model.id,
        ...(epicId ? ["--epic", epicId] : []),
        ...(probeWorktree ? ["--probe-worktree", probeWorktree] : []),
      ], {
        cwd: ROOT,
        windowsHide: true,
        shell: process.platform === "win32",
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HIVEMIND_DB_URL: dbUrl, ...(await providerEnvFor(model.provider)) },
      }), {
        providers: async () => providerOverride ? [providerOverride] : await modelPolicy.providersFor("verify"),
        modelFor: (provider, purpose) => modelPolicy.resolve(purpose, provider),
        health: providerHealth,
        policy: await breakerPolicy(config),
        now: Date.now,
        // Only what the error catalogue recognises says anything about the
        // provider; a defect of ours is UNKNOWN, and re-running the whole sweep
        // on the rest of the chain would only reproduce it.
        isProviderFault: (message) => classifyError(message).class !== "UNKNOWN",
      });
    } catch (cause) {
      // Nothing in the chain can sweep right now, or the one provider that
      // could is inside a window short enough to wait out. Either way no sweep
      // ran, which is what the caller is told; the next cycle asks again.
      if (cause instanceof AllProvidersUnavailableError || cause instanceof ProviderDeferredError) {
        console.warn(`regression sweep for ${slug} did not run: ${cause.message}`);
        return false;
      }
      throw cause;
    }
    if (result.stdout.trim()) console.log(`regression sweep (${plan.reason}): ${result.stdout.trim()}`);
    // The summary is the last line, not the whole of stdout: npm prints its own
    // banner ahead of the child, so parsing everything never once succeeded and
    // the warning below has never reached anybody.
    const summaryLine = result.stdout.trimEnd().split("\n")
      .toReversed().find((line) => line.trimStart().startsWith("{"));
    let summary: SweepSummary | undefined;
    try {
      if (summaryLine) summary = JSON.parse(summaryLine) as SweepSummary;
    } catch {
      // The sweep printed something other than its JSON summary; the raw line
      // above is the record, and there is nothing further to read from it.
    }
    if (summary?.attributionsSkipped) {
      console.warn(`regression cards raised without attribution: ${summary.attributionsSkipped}`);
    }
    // A scenario the sweep failed and the bisect could then not reproduce at
    // either end is either a flaky break or a flaky run, and the two are told
    // apart by what else this host was driving at the time: an event sweep does
    // not wait for the foreground to go quiet, so its browser can be one of
    // several. Nothing recorded that, so the question was only ever answerable
    // by guessing. S-R237511MB-02 sat on it for a day: five scenarios failed at
    // once and two probes on the same revision passed.
    const unreproduced = (summary?.attributions ?? [])
      .filter((entry) => entry.attribution?.kind === "not_reproduced")
      .map((entry) => entry.scenarioId);
    if (unreproduced.length > 0) {
      await store.recordFriction({
        cardId: sweepCard,
        runId: `regression:${sweepCard}`,
        kind: "sweep_unreproduced",
        detail: JSON.stringify({
          pool: plan.pool,
          reason: plan.reason,
          scenarios: unreproduced,
          failed: summary?.failed?.length ?? 0,
          swept: plan.scenarioIds.length,
          storiesInFlight: foreground,
        }),
      });
    }
    return true;
  };

  const cycle = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // First: everything below works in a checkout, and a repository whose
      // checkout could not be brought up cannot serve a card this cycle. A new
      // registration is picked up here, without a restart.
      await step("repository checkouts", async () => {
        const ready: typeof servable = [];
        for (const repository of await repositories.list()) {
          try {
            await ensureCheckout({
              url: repository.remoteUrl,
              slug: repository.slug,
              defaultBranch: repository.defaultBranch,
              workRoot,
            }, { refresh: true });
            ready.push(repository);
          } catch (error) {
            await reportP0(`${repository.slug} cannot be checked out on this host`, error);
          }
        }
        servable = ready;
      });
      if (servable.length === 0) return;
      await step("intake sync", syncIntake);
      await step("projection reconciliation", reconcileProjections);
      // Reported, not raised, for the same reason the regression sweep is: one
      // Epic that cannot be split has nothing to do with the Stories already
      // split out of the others. Raising it ended the cycle before dispatch,
      // so a single spent account stopped every Story on the host and kept
      // stopping it, one silent cycle at a time.
      await reportedStep("epic decomposition", decomposeWaitingEpic);
      // Same reason again: Epic upkeep is background work about Epics, and a
      // branch or a head recheck it cannot finish says nothing about the
      // Stories waiting to be dispatched below it.
      await reportedStep("epic maintenance", maintainEpics);
      // Before dispatch, not after. Called after, it saw the Stories this very
      // cycle had just put in flight and gave way to them; and the cycle
      // returns early when there is nothing to dispatch, which is exactly when
      // the host is idle enough to sweep. Between the two the sweep was
      // unreachable in both directions, which is why regression_runs was empty
      // after six delivered Stories.
      // Reported, not raised. A sweep is a safety net running behind the
      // foreground; letting its failure end the cycle stopped intake,
      // projection and dispatch for every Story on the host because one Epic's
      // worktree was in a state git would not allow.
      await reportedStep("regression sweep", regressionSweep);

      const slugs = servable.map((repository) => repository.slug);
      const rows = (await handle.client.execute({
        sql: `SELECT id, state, epic_id, repo, branch, target_branch, depends_on, predicted_footprint
                FROM stories WHERE repo IN (${slugs.map(() => "?").join(", ")})
               ORDER BY priority ASC, created_at ASC`,
        args: slugs,
      })).rows;
      const byId = new Map(rows.map((row) => [String(row.id), row]));
      // A Story waiting on an Epic head that is still failing would run the
      // whole merge again, re-run the repository's suite, and write down the
      // same refusal - once per cycle, for as long as the head stays red. The
      // recheck above is what looks at it, at a rate it decides.
      const headFailures = await unrecoveredHeadFailures(handle.client);
      // Footprints decide what may run beside what; priority only decides the
      // order within a batch that is already free of conflicts. Each repository
      // is planned against its own hotspot paths, because a hotspot is a path
      // in one repository's tree.
      // Whoever holds a live lease is writing a worktree right now, on this
      // host or another. Read from the lease table rather than this process's
      // own in-flight map, for the same reason the dispatch filter below does:
      // a restarted orchestrator has an empty map and a full table.
      const dispatchQueue = new DispatchQueue(handle.client);
      const heldNow = new Set((await dispatchQueue.held()).map((lease) => lease.cardId));
      const plan = planDispatchAcrossRepositories(await Promise.all(slugs.map(async (slug) => ({
        slug,
        hotspotPaths: (await configFor(slug)).get("schedule.hotspotPaths"),
        running: rows.filter((row) => String(row.repo) === slug && heldNow.has(String(row.id)))
          .map((row) => String(row.id)),
        // Read off the checkout, which the cycle refreshed to the default
        // branch: until a contract is on the branch, the first card is the one
        // that puts it there and the rest would each invent their own.
        hasInterfaceContract: (await readInterfaceContract(
          join(checkoutOf(slug), (await configFor(slug)).get("prototype.root")),
        )).kind === "present",
        stories: rows.filter((row) => String(row.repo) === slug && !(
          String(row.state) === "MERGE" && headFailures.has(String(row.epic_id ?? ""))
        )).map((row) => {
          const story: RepositoryStory = {
            id: String(row.id),
            state: String(row.state),
            dependsOn: JSON.parse(String(row.depends_on ?? "[]")) as string[],
            predictedFootprint: JSON.parse(String(row.predicted_footprint ?? "[]")) as string[],
          };
          if (row.epic_id) story.epicId = String(row.epic_id);
          return story;
        }),
      }))));
      for (const cycleFound of plan.cycles) {
        // Reported per repository rather than raised: another repository's
        // Stories have nothing to do with this graph.
        await reportP0(
          `Story dependencies form a cycle in ${cycleFound.slug}`,
          new Error(cycleFound.cycle.join(" -> ")),
        );
      }
      for (const held of plan.stranded) {
        console.warn(`${held.slug}: Stories waiting on something outside the set: ${held.cardIds.join(", ")}`);
      }
      const batch = plan.batch.map((entry) => entry.cardId).filter((cardId) => !inFlight.has(cardId));
      if (batch.length === 0) return;

      // One account per vendor: the window and the concurrency limit belong to
      // the account, so the breaker state that decides this is central.
      const chain = providerOverride ? [providerOverride] : await modelPolicy.providersFor("code");
      // The single refresher. Every pi process the workers spawn probes the
      // shared credential file read-only; this is the one place that rotates
      // the token, so two refreshes can never invalidate each other.
      for (const name of chain) {
        // Only an OAuth credential can be refreshed; an API key does not
        // expire, and pi has no token to rotate for it.
        if (needsApiKeyEnv(await modelPolicy.profileOf(name))) continue;
        const outcome = await refreshCredentialsOnce({
          lockPath: credentialLockPath,
          minIntervalMs: config.get("provider.credentialRefreshIntervalMs"),
          lastRefreshedAt: async () => {
            try {
              return (await stat(credentialFilePath)).mtimeMs;
            } catch {
              // No credential file yet: pi login has not run on this host, and
              // the readiness probe below is what reports that.
              return 0;
            }
          },
          refresh: async () => {
            await refreshProviderCredentials(piBinary, name);
          },
        });
        if (outcome === "failed") console.warn(`credential refresh failed for ${name}; the readiness probe decides what that means`);
      }
      // A breaker that opened on credentials names no window of its own, so the
      // read-only probe is the only thing that can ever close it again.
      await probeOpenProviders(
        chain,
        providerHealth,
        async (name) => probeProviderReadiness(piBinary, name, await providerEnvFor(name)),
        await breakerPolicy(config),
      );
      const healths = await providerHealth.snapshot();
      if (intakeHalted(chain, healths, Date.now())) {
        const detail = chain.map((name) => `${name}=${healths.get(name)?.lastErrorClass ?? "open"}`).join(", ");
        console.warn(`intake halted: every provider in the chain is open (${detail})`);
        await alerts.send({
          kind: "p0",
          title: "Every model provider is unavailable",
          body: `hivemind stopped taking cards: ${detail}`,
        }).catch((cause: unknown) => console.error("P0 alert failed:", (cause as Error).message));
        return;
      }
      await config.reload();
      // The machine-level total gate. Per-provider throttling is a separate
      // layer the subprocesses take for themselves, one slot per spawn, so
      // this number only bounds how many cards this host works on at once.
      const limit = config.get("schedule.maxConcurrentStories");
      // A card a live lease already holds is not dispatchable, whoever holds
      // it. Asking the lease table rather than this process's own map is what
      // keeps a restart from forking a second subprocess onto a running card.
      const free = await dispatchQueue.dispatchable(batch);
      for (const cardId of free) {
        if (inFlight.size >= limit) break;
        const row = byId.get(cardId);
        if (!row) continue;
        const attempt = runStory(cardId, row)
          .catch((error: unknown) => reportP0(`Story ${cardId} failed`, error))
          .finally(() => inFlight.delete(cardId));
        inFlight.set(cardId, attempt);
      }
    } finally {
      running = false;
      // Push, with the service's own timer as the fallback: a missed nudge
      // costs a reader some latency, never correctness.
      projections.nudge();
    }
  };

  const runCycle = async (): Promise<void> => {
    try {
      await cycle();
    } catch (error) {
      await reportP0("Local orchestrator cycle failed", error);
      throw error;
    }
  };

  // Ring 2, before the first cycle rather than after it. The cycle nudges the
  // projections when it ends, so a service declared further down is in its
  // temporal dead zone on that first pass: every start reported a P0 and lost
  // its opening cycle, and --once never ran one at all. Nothing on the
  // delivery path reads it, so stopping it costs the console its numbers and
  // costs no card a thing.
  const projections = new ProjectionService(handle.client, {
    onError: (error) => console.warn(`projection refresh failed: ${(error as Error).message}`),
  });
  projections.start();

  if (once) {
    await runCycle();
    // A cycle dispatches Story runs and returns; they are still running. The
    // daemon drains them before it closes anything, and one cycle has to do
    // the same: closing the database under a live run kills it with
    // CLIENT_CLOSED, which is reported as the Story failing. Leaving the
    // projection service running is what kept the process alive afterwards,
    // refreshing against a closed client once a second forever.
    if (inFlight.size > 0) {
      console.log(`Waiting for ${inFlight.size} in-flight Story run(s) before exit`);
      await Promise.allSettled(inFlight.values());
    }
    await media.waitForIdle();
    await projections.stop();
    handle.close();
    return;
  }
  // A daemon must survive a failing cycle; only --once propagates the error.
  await runCycle().catch((error) => {
    console.error("Initial cycle failed:", (error as Error).message);
  });
  const app = Fastify({ logger: false });
  await registerNotionWebhookRoute(app, {
    ...(webhookSecret ? { secret: webhookSecret } : {
      captureVerificationToken: async (tokenValue: string) => {
        await upsertSecretFile("HIVEMIND_NOTION_WEBHOOK_SECRET", tokenValue);
        console.log("Notion webhook verification token captured; restart the orchestrator before enabling events.");
      },
    }),
    coordinator,
  });
  const host = optional("--host") ?? "127.0.0.1";
  const port = Number(optional("--port") ?? "3212");
  await app.listen({ host, port });
  coordinator.start();
  const timer = setInterval(() => void runCycle().catch((error) => {
    console.error("Local orchestrator cycle failed:", (error as Error).message);
  }), intervalMs);
  console.log(`Local orchestrator ${hostname()} listening on http://${host}:${port}`);

  // The console is a read of the same central store, so it lives in this
  // process: nothing it shows comes from anywhere else, and a second service
  // would be one more thing to keep alive for no more truth. It refuses a
  // public wildcard bind itself.
  let operationsConsole: Awaited<ReturnType<typeof createConsoleServer>> | undefined;
  if (config.get("console.enabled")) {
    const uiRoot = join(ROOT, "console-ui", "dist");
    const consoleData = new LibsqlConsoleDataSource(handle.client, async () => [{
        hostId: hostname(),
        status: "healthy",
        node: process.version,
        repository: servable.map((repository) => repository.slug).join(","),
      }], () => ({
        ...projections.fleet(),
        invariantFindings: projections.findings(),
        rejections: projections.rejections(),
      }));
    operationsConsole = await createConsoleServer(
      consoleData,
      {
        uiRoot,
        serveUi: await exists(join(uiRoot, "index.html")),
        configWriter: new ConsoleConfigWriter(config, handle.client),
        todoRead: todoReadPort,
        todoCommands: todoDecisionStore,
        // This process owns the central store, so it is the mount that may
        // write. A mount that wants the form says so; nothing infers it.
        costLimitStore: consoleData.requirementCostLimitStore,
      },
    );
    const address = await listenConsole(operationsConsole, {
      host: config.get("console.host"),
      port: config.get("console.port"),
    });
    console.log(`Console at ${address}`);
  }

  const stop = async (): Promise<void> => {
    stopping = true;
    clearInterval(timer);
    // A Story worker keeps running after its parent dies, and a restarted
    // orchestrator would dispatch the same card again beside it: drain first.
    if (inFlight.size > 0) {
      console.log(`Waiting for ${inFlight.size} in-flight Story run(s) before exit`);
      // The cycle timer is what normally empties the outbox, and it has just
      // been cleared -- while a Story runs on for another hour the board would
      // show nothing it does. Keep the postman walking: the health probe reads
      // an unsent write as the system being stuck, and during a drain it would
      // be right.
      const postman = setInterval(() => {
        void sendQueuedNotionWrites().catch(() => undefined);
      }, DRAIN_OUTBOX_INTERVAL_MS);
      postman.unref?.();
      try {
        await Promise.allSettled(inFlight.values());
      } finally {
        clearInterval(postman);
      }
      await sendQueuedNotionWrites().catch(() => undefined);
    }
    coordinator.stop();
    await coordinator.waitForIdle();
    await media.waitForIdle();
    await app.close();
    await operationsConsole?.close();
    await projections.stop();
    // Freed before the handle closes, so a restart takes the role at once
    // instead of waiting out the lapse.
    await singleton.release().catch(() => undefined);
    handle.close();
  };
  // A second signal stops waiting. The drain above is deliberately unbounded
  // -- a round in flight has already been paid for -- but an operator with a
  // fix to deploy cannot be made to wait out a whole inner loop, and guessing
  // a deadline here would be guessing at their trade rather than letting them
  // make it. The child handles SIGTERM: its run settles as cancelled and keeps
  // every budget, so what a second signal costs is this round's tokens.
  let draining = false;
  const signalled = (): void => {
    if (!draining) {
      draining = true;
      void stop().then(() => process.exit(0));
      return;
    }
    if (storyChildren.size === 0) return;
    console.log(`Stopping ${storyChildren.size} in-flight Story run(s) now; each keeps its budget`);
    for (const child of storyChildren) child.kill("SIGTERM");
  };
  // Losing the claim means another daemon owns the role and is writing. Ours
  // stops at once rather than draining: a drain keeps the outbox walking, which
  // is exactly the second writer the claim exists to prevent. The children are
  // signalled first so they settle as cancelled and keep their budgets.
  onClaimLost = (reason: string): void => {
    console.error(`FAILED: this orchestrator no longer holds the role (${reason})`);
    for (const child of storyChildren) child.kill("SIGTERM");
    process.exit(1);
  };
  process.on("SIGINT", signalled);
  process.on("SIGTERM", signalled);
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${(error as Error).message}`);
  process.exit(1);
});
