import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { ConfigStore } from "../src/config/store.js";
import { CommentIngestor } from "../src/notion/comment-ingest.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { NotionClarificationChannel } from "../src/notion/notion-clarification-channel.js";
import { NotionOutbox } from "../src/notion/outbox.js";
import {
  NotionRequirementPageDelivery,
  REQUIREMENT_OUTBOX_OPERATIONS,
} from "../src/notion/requirement-page-delivery.js";
import { RequirementPageProjector } from "../src/notion/requirement-projection.js";
import { NotionRequirementInputSync } from "../src/notion/requirement-input-sync.js";
import { ingestRequirements } from "../src/notion/requirement-intake.js";
import { NotionGatewayCommentSource, createNotionHttpTransport } from "../src/notion/sdk-adapters.js";
import { NotionUserDirectory } from "../src/notion/user-directory.js";
import { AcceptanceChecklist } from "../src/orchestrator/acceptance-checklist.js";
import { ClarificationChannelSet } from "../src/orchestrator/clarification-channel.js";
import { ClarifyLoop } from "../src/orchestrator/clarify-loop.js";
import { PiPmPort } from "../src/orchestrator/pi-pm-port.js";
import { PrdRunner } from "../src/orchestrator/prd-runner.js";
import { RequirementDecomposer } from "../src/orchestrator/requirement-decompose.js";
import { RequirementStore } from "../src/orchestrator/requirement-store.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";
import { ModelPolicy } from "../src/runner/model-policy.js";
import { PiModelCatalog } from "../src/runner/model-resolver.js";
import { defaultPiBinary } from "../src/runner/pi-binary.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function optional(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Drives the product manager layer: takes in new requirement cards, advances
 * each one by a single step, then flushes everything it owes Notion. One step
 * per pass keeps a crash cheap — the next pass reads the database and carries
 * on from whatever actually landed.
 */
async function main(): Promise<void> {
  const stored = await loadSecretsFile();
  const token = process.env.NOTION_TOKEN ?? stored.get("NOTION_TOKEN");
  const requirementsDataSourceId = process.env.HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID ??
    stored.get("HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID");
  const epicsDataSourceId = process.env.HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID ??
    stored.get("HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID");
  if (!token) throw new Error("NOTION_TOKEN is missing from ~/.hivemind/secrets.env");
  if (!requirementsDataSourceId) throw new Error("HIVEMIND_NOTION_REQUIREMENTS_DATA_SOURCE_ID is missing");
  if (!epicsDataSourceId) throw new Error("HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID is missing");

  const repositorySlug = optional("--repository-slug");
  const intervalMs = Number(optional("--interval-ms") ?? "30000");
  const once = process.argv.includes("--once");
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error("--interval-ms must be at least 1000");

  const handle = openDb(process.env.HIVEMIND_DB_URL ?? "file:data/hivemind.db");
  await migrate(handle.client);
  const config = await ConfigStore.load(handle.client);
  const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token }) });
  const store = new RequirementStore(handle.client);
  const outbox = new NotionOutbox(handle.client);
  const projector = new RequirementPageProjector(store, outbox);
  const delivery = new NotionRequirementPageDelivery(handle.client, gateway, epicsDataSourceId);
  const botUserId = stored.get("NOTION_BOT_USER_ID");
  const comments = new CommentIngestor(
    handle.client,
    new NotionGatewayCommentSource(gateway),
    {
      users: new NotionUserDirectory(handle.client, gateway),
      ...(botUserId ? { botUserId } : {}),
    },
  );
  const channels = new ClarificationChannelSet([
    new NotionClarificationChannel(handle.client, gateway, comments),
  ]);

  const piBinary = defaultPiBinary();
  const catalog = new PiModelCatalog({ binary: piBinary });
  const policy = new ModelPolicy(config, catalog);
  const provider = optional("--provider") ?? (await policy.providersFor("product_manager"))[0];
  if (!provider) throw new Error("no provider in the failover chain serves the product manager tier");
  const model = await policy.resolve("product_manager", provider);
  const pm = new PiPmPort({
    binary: piBinary,
    model,
    promptRoot: resolve(ROOT, "prompts"),
    cwd: resolve(optional("--repository-path") ?? ROOT),
  });

  const clarify = new ClarifyLoop(store, channels, pm, projector, {
    maxRounds: config.get("requirement.maxClarifyRounds"),
    maxQuestionsPerRound: config.get("requirement.maxQuestionsPerRound"),
  });
  const prd = new PrdRunner(store, pm, projector);
  const decomposer = new RequirementDecomposer(handle.client, store, pm, projector);
  const acceptance = new AcceptanceChecklist(handle.client, store, projector);
  const humanInput = new NotionRequirementInputSync(handle.client, gateway, comments, store, acceptance);

  // What a person did on the page since the last pass: a verdict on the PRD,
  // ticks and notes on the acceptance list, parking. Read before the
  // requirement is advanced so the step acts on the latest word.
  const readHumanInput = async (): Promise<void> => {
    const active = (await handle.client.execute(
      "SELECT id, state FROM requirements WHERE state NOT IN ('DONE', 'FAILED') ORDER BY id",
    )).rows;
    for (const row of active) {
      const requirementId = String(row.id);
      const property = await humanInput.pollProperties(requirementId);
      if (property.intent !== "none" && property.intent !== "initialized") {
        console.log(`${requirementId} status drag: ${property.intent}${property.applied ? "" : " (not applied)"}`);
      }
      const state = String(row.state);
      if (state === "PRD_CONFIRM" || state === "ACCEPTANCE") {
        const commented = await humanInput.pollComments(requirementId);
        if (commented.prdConfirmed) console.log(`${requirementId} PRD confirmed by comment`);
        if (commented.revisionRequested) console.log(`${requirementId} PRD revision requested by comment`);
        if (commented.gapsRecorded > 0) console.log(`${requirementId} acceptance gaps noted: ${commented.gapsRecorded}`);
      }
      if (state === "ACCEPTANCE") {
        const ticked = await humanInput.pollContent(requirementId);
        if (ticked.ticked > 0) console.log(`${requirementId} scenarios accepted by tick: ${ticked.ticked}`);
      }
    }
  };

  const pass = async (): Promise<void> => {
    await config.reload();
    for (const intake of await ingestRequirements(
      store,
      gateway,
      requirementsDataSourceId,
      repositorySlug,
    )) {
      console.log(`took in requirement ${intake.id}: ${intake.title}`);
    }
    await readHumanInput();

    for (const requirement of await store.listActionable("CLARIFY")) {
      const outcome = await clarify.advance(requirement.id);
      console.log(`${requirement.id} clarify: ${outcome.kind}`);
    }
    for (const requirement of await store.listActionable("PRD_CONFIRM")) {
      const outcome = await prd.advance(requirement.id);
      console.log(`${requirement.id} PRD: ${outcome.kind}`);
    }
    for (const requirement of await store.listActionable("DECOMPOSING")) {
      const outcome = await decomposer.decompose(requirement.id);
      console.log(`${requirement.id} decompose: ${outcome.kind}`);
    }
    for (const requirement of await store.listActionable("EXECUTING")) {
      if (!await decomposer.canEnterAcceptance(requirement.id)) continue;
      const items = await acceptance.open(requirement.id);
      console.log(`${requirement.id} acceptance: ${items.length} scenarios awaiting a verdict`);
    }
    for (const requirement of await store.listActionable("ACCEPTANCE")) {
      const outcome = await acceptance.settle(requirement.id);
      console.log(`${requirement.id} acceptance: ${outcome.kind}`);
    }

    // The orchestrator shares this outbox; each side replays only its own rows.
    const replayed = await outbox.replay(delivery, { operations: REQUIREMENT_OUTBOX_OPERATIONS });
    if (replayed.sent > 0 || replayed.failed > 0) {
      console.log(`Notion outbox: ${replayed.sent} sent, ${replayed.failed} failed`);
    }
  };

  await pass();
  if (once) return;
  for (;;) {
    await new Promise((settle) => setTimeout(settle, intervalMs));
    await pass().catch((error: unknown) => {
      console.error(`requirement pass failed: ${(error as Error).message}`);
    });
  }
}

main().catch((error: unknown) => {
  console.error(`FAILED: ${(error as Error).message}`);
  process.exit(1);
});
