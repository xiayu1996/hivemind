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
import { loadSecretsFile, upsertSecretFile } from "../src/config/secrets-file.js";
import { ConfigStore } from "../src/config/store.js";
import { breakerPolicy, intakeHalted, usableProviders } from "../src/runner/circuit-breaker.js";
import { assertProviderRetriesDisabled } from "../src/runner/failover.js";
import { probeProviderReadiness } from "../src/runner/auth-probe.js";
import { probeOpenProviders } from "../src/runner/provider-probe.js";
import { assertModelPolicy, ModelPolicy } from "../src/runner/model-policy.js";
import { PiModelCatalog } from "../src/runner/model-resolver.js";
import { LibsqlProviderHealthStore } from "../src/runner/provider-health-store.js";
import { CommentIngestor } from "../src/notion/comment-ingest.js";
import { NotionEpicInputSync } from "../src/notion/epic-input-sync.js";
import { NotionGateway, NotionGatewayError } from "../src/notion/gateway.js";
import { NotionMediaReconciler } from "../src/notion/media-reconciler.js";
import { NotionMediaPipeline } from "../src/notion/media.js";
import { NotionOutbox } from "../src/notion/outbox.js";
import {
  NotionGatewayCommentSource,
  NotionGatewayMediaPort,
  createNotionHttpTransport,
} from "../src/notion/sdk-adapters.js";
import { NotionGatewayStoryApi, ingestReadyStories } from "../src/notion/story-intake.js";
import { NotionStoryInputSync } from "../src/notion/story-input-sync.js";
import { NotionStoryPageDelivery } from "../src/notion/story-page-delivery.js";
import { NotionStoryDelivery, NotionStoryPropertyDelivery } from "../src/notion/story-property-delivery.js";
import { NotionStoryProjection } from "../src/notion/story-projection.js";
import { NotionSyncCoordinator, type NotionSyncPoller } from "../src/notion/sync.js";
import { registerNotionWebhookRoute } from "../src/notion/webhook-route.js";
import { PlanApprovalStore } from "../src/orchestrator/plan-approval.js";
import { StoryExecutionStore } from "../src/orchestrator/story-execution-store.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { createWorktree, locateWorktree, worktreeLayout } from "../src/vcs/worktree.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

async function main(): Promise<void> {
  const stored = await loadSecretsFile();
  const token = process.env.NOTION_TOKEN ?? stored.get("NOTION_TOKEN");
  const dataSourceId = process.env.HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID ??
    stored.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID");
  const webhookSecret = process.env.HIVEMIND_NOTION_WEBHOOK_SECRET ??
    stored.get("HIVEMIND_NOTION_WEBHOOK_SECRET");
  if (!token) throw new Error("NOTION_TOKEN is missing from ~/.hivemind/secrets.env");
  if (!dataSourceId) throw new Error("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID is missing");
  const alertChannels = alertChannelsFromConfig(stored);
  const alerts = new AlertRouter(alertChannels);

  const repositoryPath = resolve(required("--repository-path"));
  const repositoryId = required("--repository-id");
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
  const intervalMs = Number(optional("--interval-ms") ?? "10000");
  const once = process.argv.includes("--once");
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error("--interval-ms must be at least 1000");

  const dbUrl = process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db";
  const handle = openDb(dbUrl);
  await migrate(handle.client);
  const gateway = new NotionGateway({
    transport: createNotionHttpTransport({ token }),
  });
  const store = new StoryExecutionStore(handle.client);
  const config = await ConfigStore.load(handle.client);
  const providerHealth = new LibsqlProviderHealthStore(handle.client);
  const piBinary = process.env.PI_BIN ?? join(homedir(), ".hivemind", "pi", "0.84.3", "pi",
    process.platform === "win32" ? "pi.exe" : "pi");
  const modelPolicy = new ModelPolicy(config, new PiModelCatalog({ binary: piBinary }));
  await assertOutOfBandChannel(alerts, config);
  await assertProviderRetriesDisabled(config);
  await assertModelPolicy(config, new PiModelCatalog({ binary: piBinary }));
  const storyApi = new NotionGatewayStoryApi(gateway);
  const botUserId = stored.get("NOTION_BOT_USER_ID");
  const comments = new CommentIngestor(
    handle.client,
    new NotionGatewayCommentSource(gateway),
    botUserId ? { botUserId } : {},
  );
  const inputSync = new NotionStoryInputSync(handle.client, gateway, storyApi, comments, store);
  const epicInputSync = new NotionEpicInputSync(
    handle.client,
    gateway,
    comments,
    new PlanApprovalStore(handle.client),
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
  );

  let coordinator: NotionSyncCoordinator;
  const registerActiveStories = async (): Promise<void> => {
    const epics = (await handle.client.execute({
      sql: "SELECT notion_page_id FROM epics WHERE state = 'PLAN_APPROVAL' ORDER BY id",
    })).rows;
    for (const epic of epics) {
      const pageId = String(epic.notion_page_id);
      await comments.registerPage(pageId, []);
      coordinator.registerActivePage(pageId);
    }
    const stories = (await handle.client.execute({
      sql: `SELECT id, notion_page_id FROM stories
            WHERE state NOT IN ('DELIVERED', 'FAILED') ORDER BY id`,
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
    const stories = (await handle.client.execute("SELECT id FROM stories ORDER BY id")).rows;
    for (const story of stories) await projection.enqueue(String(story.id));
    await outbox.replay(delivery);
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
  const cycle = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await syncIntake();
      await reconcileProjections();
      const queued = (await handle.client.execute({
        sql: `SELECT id, repo, branch, target_branch FROM stories
              WHERE state IN ('QUEUED', 'DESIGN', 'CODE', 'MERGE') AND repo = ?
              ORDER BY priority ASC, created_at ASC LIMIT 1`,
        args: [repositorySlug],
      })).rows[0];
      if (!queued) return;
      const cardId = String(queued.id);
      // One account per vendor: the window and the concurrency limit belong to
      // the account, so the breaker state that decides this is central.
      const chain = providerOverride ? [providerOverride] : await modelPolicy.providersFor("code");
      // A breaker that opened on credentials names no window of its own, so the
      // read-only probe is the only thing that can ever close it again.
      await probeOpenProviders(
        chain,
        providerHealth,
        (name) => probeProviderReadiness(piBinary, name),
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
      if (!queued.branch) throw new Error(`Story ${cardId} does not declare a branch`);
      const branch = String(queued.branch);
      const targetBranch = queued.target_branch ? String(queued.target_branch) : "main";
      if (!queued.repo) throw new Error(`Story ${cardId} does not declare a repository`);
      const layout = worktreeLayout(workRoot);
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
          "--context", `repository=${join(location.worktreePath, "AGENTS.md")}`,
        ], {
          cwd: ROOT,
          windowsHide: true,
          // Windows refuses to spawn .cmd shims without a shell (EINVAL).
          shell: process.platform === "win32",
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, HIVEMIND_DB_URL: dbUrl },
        });
      } catch (error) {
        // The provider's own health is separate from the card's: this records
        // why the attempt died so the breaker can drop that node of the chain.
        await providerHealth.recordFailure(
          provider,
          error instanceof Error ? error.message : String(error),
          await breakerPolicy(config),
        );
        // The worker already recorded the phase failure. Bound automatic
        // reentries: DESIGN and CODE re-dispatch until the budget is spent,
        // VERIFY/MERGE failures park immediately for a human resume decision.
        // A card that never left QUEUED failed before the pipeline started, so
        // nothing recorded the attempt: without counting it here the dispatch
        // query selects the same card on every cycle, forever.
        const card = await store.getStory(cardId).catch(() => undefined);
        if (card && card.state !== "DELIVERED") {
          await config.reload();
          const budget = config.get("retry.maxPhaseReentries");
          await store.recordPhaseReentry(cardId);
          const reentries = card.phaseReentries + 1;
          const reenterable = ["QUEUED", "DESIGN", "CODE"].includes(card.state) && reentries < budget;
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
      if (completed.state === "NEEDS_INPUT" && !(await alertNeedsInput(alerts, completed))) {
        console.error(`Story ${cardId} stopped for input but no out-of-band channel took the alert`);
      }
    } finally {
      running = false;
    }
  };

  let lastP0 = "";
  let lastP0At = 0;
  const runCycle = async (): Promise<void> => {
    try {
      await cycle();
    } catch (error) {
      const message = error instanceof Error ? error.message : "local orchestrator cycle failed";
      const time = Date.now();
      if (message !== lastP0 || time - lastP0At >= 10 * 60_000) {
        lastP0 = message;
        lastP0At = time;
        if (alerts.channelCount === 0) {
          console.error("P0: local orchestrator cycle failed (no out-of-band alert channel):", message);
        } else {
          const deliveryResult = await alerts.send({
            kind: "p0",
            title: "Local orchestrator cycle failed",
            body: message,
          });
          if (deliveryResult.delivered.length === 0) {
            console.error("P0 alert failed on every channel:", JSON.stringify(deliveryResult.failed));
          }
        }
      }
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
