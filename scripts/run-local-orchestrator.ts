import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { alertChannelsFromConfig } from "../src/alert/config.js";
import { AlertRouter } from "../src/alert/index.js";
import { alertNeedsInput } from "../src/alert/story-alerts.js";
import { loadSecretsFile, upsertSecretFile } from "../src/config/secrets-file.js";
import { CommentIngestor } from "../src/notion/comment-ingest.js";
import { NotionGateway } from "../src/notion/gateway.js";
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
  if (alertChannels.length === 0) {
    throw new Error("configure FEISHU_WEBHOOK_URL or SMTP settings for out-of-band alerts");
  }
  const alerts = new AlertRouter(alertChannels);

  const repositoryPath = resolve(required("--repository-path"));
  const repositoryId = required("--repository-id");
  const model = required("--model");
  const provider = optional("--provider") ?? "openai-codex";
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
  const storyApi = new NotionGatewayStoryApi(gateway);
  const botUserId = stored.get("NOTION_BOT_USER_ID");
  const comments = new CommentIngestor(
    handle.client,
    new NotionGatewayCommentSource(gateway),
    botUserId ? { botUserId } : {},
  );
  const inputSync = new NotionStoryInputSync(handle.client, gateway, storyApi, comments, store);
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
  const poller: NotionSyncPoller = {
    pollProperties: async (pageId) => {
      await syncIntake();
      await inputSync.pollProperties(pageId);
    },
    pollContent: async (pageId) => {
      await syncIntake();
      await inputSync.pollContent(pageId);
    },
    pollComments: async (pageId) => { await inputSync.pollComments(pageId); },
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
              WHERE state IN ('QUEUED', 'CODE') ORDER BY priority ASC, created_at ASC LIMIT 1`,
      })).rows[0];
      if (!queued) return;
      const cardId = String(queued.id);
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
      const result = await execFileAsync(npm, [
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
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HIVEMIND_DB_URL: dbUrl },
      });
      if (result.stdout.trim()) console.log(result.stdout.trim());
      await reconcileProjections();
      const completed = await store.getStory(cardId);
      await alertNeedsInput(alerts, completed);
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
        const deliveryResult = await alerts.send({
          kind: "p0",
          title: "Local orchestrator cycle failed",
          body: message,
        });
        if (deliveryResult.delivered.length === 0) {
          console.error("P0 alert failed on every channel:", JSON.stringify(deliveryResult.failed));
        }
      }
      throw error;
    }
  };

  await runCycle();
  if (once) {
    await media.waitForIdle();
    handle.close();
    return;
  }
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
