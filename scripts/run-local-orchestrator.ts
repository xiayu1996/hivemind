import type { Row } from "@libsql/client";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { alertChannelsFromConfig } from "../src/alert/config.js";
import { AlertRouter } from "../src/alert/index.js";
import { alertNeedsInput } from "../src/alert/story-alerts.js";
import { assertOutOfBandChannel } from "../src/alert/required-channel.js";
import { diagnoseRetryLimit, renderRetryReport } from "../src/pipeline/retry-limits.js";
import { ScenarioRegistry } from "../src/regression/scenario-registry.js";
import { planRegressionSweep } from "../src/regression/scheduler.js";
import { defaultSecretsPath, loadSecretsFile, upsertSecretFile } from "../src/config/secrets-file.js";
import { ConfigStore } from "../src/config/store.js";
import { breakerPolicy, intakeHalted, usableProviders } from "../src/runner/circuit-breaker.js";
import { classifyError } from "../src/runner/classify.js";
import { assertProviderRetriesDisabled } from "../src/runner/failover.js";
import { probeProviderReadiness, refreshProviderCredentials } from "../src/runner/auth-probe.js";
import { refreshCredentialsOnce } from "../src/runner/auth-refresh.js";
import { probeOpenProviders } from "../src/runner/provider-probe.js";
import { assertErrorFixtureCoverage } from "../src/runner/error-fixtures.js";
import { assertModelPolicy, ModelPolicy } from "../src/runner/model-policy.js";
import { needsApiKeyEnv, providerKeyEnv } from "../src/runner/provider-env.js";
import { defaultModelCatalog } from "../src/runner/catalog.js";
import { LibsqlProviderHealthStore } from "../src/runner/provider-health-store.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";
import { CommentIngestor } from "../src/notion/comment-ingest.js";
import { NotionEpicInputSync } from "../src/notion/epic-input-sync.js";
import { NotionGateway, NotionGatewayError } from "../src/notion/gateway.js";
import { NotionMediaReconciler } from "../src/notion/media-reconciler.js";
import { NotionMediaPipeline } from "../src/notion/media.js";
import { NotionOutbox } from "../src/notion/outbox.js";
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
import { epicRegressionClean } from "../src/regression/epic-gate.js";
import { discoverMRPort } from "../src/vcs/mr/adapters.js";
import { NotionStoryProjection } from "../src/notion/story-projection.js";
import { NotionSyncCoordinator, type NotionSyncPoller } from "../src/notion/sync.js";
import { registerNotionWebhookRoute } from "../src/notion/webhook-route.js";
import { IntegrationDispatchStore } from "../src/orchestrator/integration-dispatch.js";
import { PlanApprovalStore } from "../src/orchestrator/plan-approval.js";
import { dispatchableStories, planRepositoryStoryExecution } from "../src/orchestrator/scheduler.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { assertSchemaCurrent } from "../src/persistence/schema-fingerprint.js";
import { createWorktree, locateWorktree, worktreeLayout } from "../src/vcs/worktree.js";
import { publishEpicBranch } from "../src/vcs/epic-branch.js";
import { processGitCommand } from "../src/vcs/story-delivery.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
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
 * back. Anything that is not a transport fault still stops the cycle.
 */
const step = async (name: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    const message = (error as Error).message;
    if (classifyError(message).class !== "TRANSPORT") throw error;
    console.warn(`${name} was skipped this cycle after a transient network fault: ${message}`);
  }
};

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

  const repositoryPath = resolve(required("--repository-path"));
  const repositoryId = required("--repository-id");
  // The Epic's integration branch goes to origin the moment its Stories exist:
  // every Story's draft MR targets it and delivery reads it from origin.
  const publishEpicBranchFor = async (epicId: string): Promise<void> => {
    try {
      const result = await publishEpicBranch({ git: processGitCommand, repositoryPath, epicId });
      if (result.pushed) console.log(`Published ${result.branch} to origin`);
    } catch (error) {
      console.error(`Publishing epic/${epicId} failed; delivery will retry before the first Story worktree is cut:`, (error as Error).message);
    }
  };
  // Cards declare the target repository as an owner/name slug; only cards
  // matching this checkout's origin are dispatched by this instance.
  const remoteUrl = (await execFileAsync("git", ["remote", "get-url", "origin"], {
    cwd: repositoryPath,
    windowsHide: true,
  })).stdout.trim();
  const withoutSuffix = remoteUrl.replace(/\.git$/, "");
  const slugMatch = /[/:]([^/:]+)\/([^/]+)$/.exec(withoutSuffix);
  if (!slugMatch) throw new Error(`cannot derive an owner/name slug from origin remote: ${remoteUrl}`);
  const repositorySlug = `${slugMatch[1]}/${slugMatch[2]}`;
  console.log(`Managing repository ${repositorySlug} (id ${repositoryId})`);
  // The chain and the tier map decide which provider serves a card; the flags
  // stay as an operator override for a single run.
  const providerOverride = optional("--provider");
  const modelOverride = optional("--model");
  const workRoot = resolve(optional("--work-root") ?? join(ROOT, "data", "work"));
  // The branch the repository integrates into; regression sweeps of the main
  // pool run against it, and Epic worktrees are cut from it.
  const targetBranchDefault = optional("--target-branch") ?? "main";
  const intervalMs = Number(optional("--interval-ms") ?? "10000");
  const once = process.argv.includes("--once");
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error("--interval-ms must be at least 1000");

  const dbUrl = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
  const handle = openDb(dbUrl);
  await migrate(handle.client);
  // Before the first card is picked up. A database an older 0001 created
  // records itself as migrated while enforcing the older constraints, and the
  // first thing that notices is a write failing inside somebody's Story.
  await assertSchemaCurrent(handle.client);
  const gateway = new NotionGateway({
    transport: createNotionHttpTransport({ token }),
  });
  const store = new StoryExecutionStore(handle.client);
  // Per-repository keys (the gate commands, the hotspot paths) are stored
  // under the card slug, so the store has to be told which repository this
  // instance manages or those keys silently read as their defaults.
  const config = await ConfigStore.load(handle.client, { repository: repositorySlug });
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
    if (!needsApiKeyEnv(profile)) return {};
    return providerKeyEnv({
      provider,
      ...(profile.envKey ? { envKey: profile.envKey } : {}),
      secrets: stored,
      secretsPath,
    });
  };
  await assertOutOfBandChannel(alerts, config);
  await assertProviderRetriesDisabled(config);
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
  const epicInputSync = new NotionEpicInputSync(
    handle.client,
    gateway,
    comments,
    new PlanApprovalStore(handle.client, Date.now, {
      maxStories: config.get("decompose.maxStoriesPerEpic"),
    }, publishEpicBranchFor),
  );
  const media = new NotionMediaReconciler(
    handle.client,
    new NotionMediaPipeline(new NotionGatewayMediaPort(gateway)),
    { onError: (error) => console.error("Notion media delivery failed:", (error as Error).message) },
  );
  const outbox = new NotionOutbox(handle.client);
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
      sql: "SELECT notion_page_id FROM epics WHERE state IN ('PLAN_APPROVAL', 'BLOCKED') ORDER BY id",
    })).rows;
    for (const epic of epics) {
      const pageId = String(epic.notion_page_id);
      await comments.registerPage(pageId, []);
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
  const syncIntake = async (): Promise<void> => {
    await ingestReadyStories(storyApi, dataSourceId, store);
    await registerActiveStories();
  };
  const reconcileProjections = async (): Promise<void> => {
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
    await enqueueEpicPages(handle.client, targetBranchDefault);
    const stories = (await handle.client.execute("SELECT id FROM stories ORDER BY id")).rows;
    for (const story of stories) await projection.enqueue(String(story.id));
    // The requirement loop shares this outbox; each side replays only its own rows.
    const replayed = await outbox.replay(delivery, { operations: STORY_OUTBOX_OPERATIONS });
    for (const failure of replayed.failures) {
      console.warn(`Notion outbox: ${failure.operation} for ${failure.cardId ?? "no card"} failed (attempt ${failure.attempts}): ${failure.error}`);
    }
    for (const letter of replayed.dead) {
      await reportP0(
        `Notion outbox gave up on ${letter.operation} for ${letter.cardId ?? "no card"}`,
        new Error(`${letter.attempts} attempts; last error: ${letter.lastError ?? "unknown"}`),
      );
    }
    await media.reconcile();
    await registerActiveStories();
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
  // Epics waiting to be split are the only source of new Stories; without this
  // the approval gate has nothing to gate and the board's Epics never move.
  const decomposeWaitingEpic = async (): Promise<void> => {
    if (!epicsDataSourceId) return;
    const waiting = await ingestEpicsForDecomposition(handle.client, gateway, epicsDataSourceId, repositorySlug);
    const pending = (await handle.client.execute(
      "SELECT id FROM epics WHERE state IN ('INTAKE', 'DECOMPOSE') ORDER BY updated_at LIMIT 1",
    )).rows[0];
    if (!pending) return;
    const epic = waiting.find((candidate) => candidate.id === String(pending.id));
    if (!epic) return;

    const chain = providerOverride ? [providerOverride] : await modelPolicy.providersFor("decompose");
    const healths = await providerHealth.snapshot();
    const provider = usableProviders(chain, healths, Date.now())[0];
    if (!provider) {
      console.warn(`no provider can decompose ${epic.id} right now`);
      return;
    }
    await config.reload();
    const decompositionLimits = { maxStories: config.get("decompose.maxStoriesPerEpic") };
    const decomposer = new EpicDecomposer(
      handle.client,
      new PlanApprovalStore(handle.client, Date.now, decompositionLimits, publishEpicBranchFor),
      new PiDecomposePort({
        binary: piBinary,
        model: await modelPolicy.resolve("decompose", provider),
        env: await providerEnvFor(provider),
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
    );
    const outcome = await decomposer.decompose(epic);
    console.log(`Epic ${epic.id} decomposition: ${outcome.kind}`);
    if (outcome.kind !== "presented") {
      await alerts.send({
        kind: "needs_input",
        title: `Epic ${epic.id} cannot be decomposed`,
        body: outcome.kind === "blocking_question" ? outcome.question.question : outcome.reasons.join("; "),
      }).catch((cause: unknown) => console.error("alert failed:", (cause as Error).message));
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

  const inFlight = new Map<string, Promise<void>>();

  const runStory = async (cardId: string, row: Row, provider: string, model: string): Promise<void> => {
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
        await publishEpicBranch({ git: processGitCommand, repositoryPath, epicId });
        let integration = locateWorktree(repositoryId, integrationCard, layout);
        if (!(await exists(integration.worktreePath))) {
          integration = await createWorktree({
            repositoryPath,
            repositoryId,
            cardId: integrationCard,
            branch: epicBranch,
            startPoint: targetBranch === epicBranch ? targetBranchDefault : targetBranch,
          }, layout);
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
      } else if (await currentBranch(location.worktreePath) !== branch) {
        throw new Error(`existing worktree for ${cardId} is not on ${branch}`);
      }
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      let result;
      try {
        result = await execFileAsync(npm, [
          "run", "story:run", "--",
          "--card-id", cardId,
          "--worktree", location.worktreePath,
          "--evidence-root", location.evidencePath,
          "--session-root", join(workRoot, "sessions", repositoryId, cardId),
          "--provider", provider,
          "--model", model,
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
          env: { ...process.env, HIVEMIND_DB_URL: dbUrl, ...(await providerEnvFor(provider)) },
        });
      } catch (error) {
        // The provider's own health is separate from the card's: this records
        // why the attempt died so the breaker can drop that node of the chain.
        // A worker that died for reasons the error catalogue does not know
        // (a defect of ours, a missing binary) says nothing about the provider
        // and must not open its breaker.
        const failureMessage = error instanceof Error ? error.message : String(error);
        const providerFault = classifyError(failureMessage).class !== "UNKNOWN";
        if (providerFault) {
          await providerHealth.recordFailure(provider, failureMessage, await breakerPolicy(config));
          // A quota window, a rate limit or an outage says nothing about the
          // card: the breaker holds dispatch until the provider is back, and
          // the card simply runs again then. Spending its reentry budget or
          // parking it would turn a provider event into a stop a person has to
          // clear by hand.
          // The breaker's own "intake halted" line is the alert for this; a P0
          // per attempt would repeat it for every card on every retry.
          console.warn(`Story ${cardId} attempt ended on a ${classifyError(failureMessage).class} provider fault; it stays ${(await store.getStory(cardId).catch(() => undefined))?.state ?? "as is"} and waits for the breaker`);
          return;
        }
        // The worker already recorded the phase failure. Bound automatic
        // reentries: DESIGN, CODE and MERGE re-dispatch until the budget is
        // spent. MERGE fails on the hosting platform as often as on the code
        // (a CLI timeout, a push refused once), so one strike is not a stop.
        // A card that never left QUEUED failed before the pipeline started, so
        // nothing recorded the attempt: without counting it here the dispatch
        // query selects the same card on every cycle, forever.
        const card = await store.getStory(cardId).catch(() => undefined);
        if (card && card.state !== "DELIVERED") {
          await config.reload();
          const budget = config.get("retry.maxPhaseReentries");
          await store.recordPhaseReentry(cardId);
          const reentries = card.phaseReentries + 1;
          const reenterable = ["QUEUED", "DESIGN", "CODE", "MERGE"].includes(card.state) && reentries < budget;
          if (!reenterable) {
            await store.stopForInput(cardId, card.state, "retry_limit_exceeded", `reentry-${cardId}`);
            console.warn(`Story ${cardId} parked after ${reentries} failed attempt(s) in ${card.state}`);
          } else {
            console.warn(`Story ${cardId} will re-enter ${card.state} (attempt ${reentries}/${budget})`);
          }
        }
        throw error;
      }
      await providerHealth.recordSuccess(provider);
      if (result.stdout.trim()) console.log(result.stdout.trim());
      await reconcileProjections();
      const completed = await store.getStory(cardId);
      if (completed.state === "NEEDS_INPUT") {
        // A spent budget is only actionable with the curve that spent it and a
        // verdict on which side to look at.
        const report = renderRetryReport(
          cardId,
          completed.stopReason ?? "needs_input",
          diagnoseRetryLimit(await store.getVerificationFailureHistory(cardId)),
        );
        console.warn(report);
        if (!(await alertNeedsInput(alerts, completed, report))) {
          console.error(`Story ${cardId} stopped for input but no out-of-band channel took the alert`);
        }
      }
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
    const freshness = new EpicBranchFreshness(handle.client, {
      worktreePath: (epicId) => locateWorktree(repositoryId, `epic-${epicId}`, layout).worktreePath,
      intervalMs: config.get("schedule.epicBranchFreshnessMs"),
    });
    for (const result of await freshness.tick()) {
      if (result.outcome === "failed") {
        console.warn(`Epic ${result.epicId} branch refresh failed: ${result.reason}`);
      }
    }

    for (const outcome of await new EpicCompletion(handle.client, await mergeRequests()).tick()) {
      if (outcome.kind === "done") console.log(`Epic ${outcome.epicId} is done: its review request landed`);
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
    const worktreePath = locateWorktree(repositoryId, `epic-${epicId}`, layout).worktreePath;
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
    await handle.client.execute({
      sql: "UPDATE epics SET state = 'EPIC_ACCEPT', mr_url = ?, updated_at = ? WHERE id = ? AND state = 'EXECUTING'",
      args: [delivered.mrUrl, Date.now(), epicId],
    });
    console.log(`Epic ${epicId} review request: ${delivered.mrUrl}`);
  };

  // The resident E2E loop. It only ever polls when this host has no Story in
  // flight; a merge invalidates its Epic's scenarios, which is what turns an
  // integration into an immediate sweep rather than an event queue.
  const registry = new ScenarioRegistry(handle.client);
  const regressionSweep = async (): Promise<void> => {
    await config.reload();
    const plan = planRegressionSweep({
      now: Date.now(),
      foregroundBusy: inFlight.size > 0,
      epicScenarios: await registry.pool("epic"),
      mainScenarios: await registry.pool("main"),
      policy: {
        epicPoolIntervalMs: config.get("regression.epicPoolIntervalMs"),
        mainPoolIntervalMs: config.get("regression.mainPoolIntervalMs"),
        batchSize: config.get("regression.batchSize"),
      },
    });
    if (!plan) return;

    const layout = worktreeLayout(workRoot);
    const epicId = plan.pool === "epic"
      ? (await registry.pool("epic")).find((scenario) => plan.scenarioIds.includes(scenario.scenarioId))?.epicId ?? null
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
      }
      probeWorktree = probeTree.worktreePath;
    }

    const chain = providerOverride ? [providerOverride] : await modelPolicy.providersFor("verify");
    const provider = usableProviders(chain, await providerHealth.snapshot(), Date.now())[0];
    if (!provider) return;
    const model = modelOverride ?? (await modelPolicy.resolve("verify", provider)).id;

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = await execFileAsync(npm, [
      "run", "regression:run", "--",
      "--pool", plan.pool,
      "--branch", branch,
      "--worktree", sweepTree.worktreePath,
      "--scenarios", plan.scenarioIds.join(","),
      "--evidence-root", join(workRoot, "evidence", repositoryId, sweepCard),
      "--provider", provider,
      "--model", model,
      ...(epicId ? ["--epic", epicId] : []),
      ...(probeWorktree ? ["--probe-worktree", probeWorktree] : []),
    ], {
      cwd: ROOT,
      windowsHide: true,
      shell: process.platform === "win32",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, HIVEMIND_DB_URL: dbUrl, ...(await providerEnvFor(provider)) },
    });
    if (result.stdout.trim()) console.log(`regression sweep (${plan.reason}): ${result.stdout.trim()}`);
    try {
      const summary = JSON.parse(result.stdout.trim()) as { attributionsSkipped?: string; attributions?: unknown[] };
      if (summary.attributionsSkipped) console.warn(`regression cards raised without attribution: ${summary.attributionsSkipped}`);
    } catch {
      // The sweep printed something other than its JSON summary; the raw line
      // above is the record, and there is nothing further to read from it.
    }
  };

  const cycle = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await step("intake sync", syncIntake);
      await step("projection reconciliation", reconcileProjections);
      await step("epic decomposition", decomposeWaitingEpic);
      await step("epic maintenance", maintainEpics);
      // Before dispatch, not after. Called after, it saw the Stories this very
      // cycle had just put in flight and gave way to them; and the cycle
      // returns early when there is nothing to dispatch, which is exactly when
      // the host is idle enough to sweep. Between the two the sweep was
      // unreachable in both directions, which is why regression_runs was empty
      // after six delivered Stories.
      await step("regression sweep", regressionSweep);

      const rows = (await handle.client.execute({
        sql: `SELECT id, state, epic_id, repo, branch, target_branch, depends_on, predicted_footprint
                FROM stories WHERE repo = ? ORDER BY priority ASC, created_at ASC`,
        args: [repositorySlug],
      })).rows;
      const byId = new Map(rows.map((row) => [String(row.id), row]));
      // Footprints decide what may run beside what; priority only decides the
      // order within a batch that is already free of conflicts.
      const plan = await planRepositoryStoryExecution(config, dispatchableStories(rows.map((row) => ({
        id: String(row.id),
        state: String(row.state),
        dependsOn: JSON.parse(String(row.depends_on ?? "[]")) as string[],
        predictedFootprint: JSON.parse(String(row.predicted_footprint ?? "[]")) as string[],
      }))));
      if (plan.kind === "dependency_cycle") {
        throw new Error(`Story dependencies form a cycle: ${plan.cycle.join(" -> ")}`);
      }
      if (plan.kind === "unschedulable") {
        console.warn(`Stories cannot be scheduled and are waiting on something outside the set: ${plan.stranded.join(", ")}`);
      }
      const batch = (plan.batches[0] ?? []).filter((cardId) => !inFlight.has(cardId));
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
      const available = usableProviders(chain, healths, Date.now());
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
      const provider = available[0]!;
      const model = modelOverride ?? (await modelPolicy.resolve("code", provider)).id;

      await config.reload();
      const limit = config.get("schedule.maxConcurrentStories");
      for (const cardId of batch) {
        if (inFlight.size >= limit) break;
        const row = byId.get(cardId);
        if (!row) continue;
        const attempt = runStory(cardId, row, provider, model)
          .catch((error: unknown) => reportP0(`Story ${cardId} failed`, error))
          .finally(() => inFlight.delete(cardId));
        inFlight.set(cardId, attempt);
      }
    } finally {
      running = false;
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

  if (once) {
    await runCycle();
    await media.waitForIdle();
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

  const stop = async (): Promise<void> => {
    clearInterval(timer);
    // A Story worker keeps running after its parent dies, and a restarted
    // orchestrator would dispatch the same card again beside it: drain first.
    if (inFlight.size > 0) {
      console.log(`Waiting for ${inFlight.size} in-flight Story run(s) before exit`);
      await Promise.allSettled(inFlight.values());
    }
    coordinator.stop();
    await coordinator.waitForIdle();
    await media.waitForIdle();
    await app.close();
    handle.close();
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${(error as Error).message}`);
  process.exit(1);
});
