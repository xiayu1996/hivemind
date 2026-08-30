// Live Notion acceptance probe for M1-18 and M1-22: drives consecutive Story
// page delivery rounds and one real File Upload attachment against the
// bootstrapped workspace. Prints only page/block identifiers, never tokens.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { NotionMediaPipeline } from "../src/notion/media.js";
import { NotionOutbox } from "../src/notion/outbox.js";
import { NotionStoryPageDelivery } from "../src/notion/story-page-delivery.js";
import {
  NotionGatewayMediaPort,
  createNotionHttpTransport,
} from "../src/notion/sdk-adapters.js";
import { openDb } from "../src/persistence/client.js";
import { migrate } from "../src/persistence/migrate.js";

interface ProbeBlock {
  id: string;
  type: string;
  text?: string;
}

function textOf(block: Record<string, unknown>): string {
  const value = block[block.type as string];
  if (!value || typeof value !== "object") return "";
  const rich = (value as { rich_text?: Array<{ plain_text?: string }> }).rich_text;
  return (rich ?? []).map((item) => item.plain_text ?? "").join("");
}

async function listChildren(gateway: NotionGateway, blockId: string): Promise<ProbeBlock[]> {
  const blocks: ProbeBlock[] = [];
  let cursor: string | undefined;
  do {
    const suffix = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "";
    const response = await gateway.request({
      method: "GET",
      path: `/v1/blocks/${encodeURIComponent(blockId)}/children?page_size=100${suffix}`,
      priority: "projection",
    });
    const payload = response.data as { results: Array<Record<string, unknown>>; has_more: boolean; next_cursor: string | null };
    for (const item of payload.results) {
      blocks.push({ id: String(item.id), type: String(item.type), text: textOf(item) });
    }
    cursor = payload.has_more ? payload.next_cursor ?? undefined : undefined;
  } while (cursor);
  return blocks;
}

async function main(): Promise<void> {
  const secrets = await loadSecretsFile();
  const token = secrets.get("NOTION_TOKEN");
  const parentId = secrets.get("HIVEMIND_NOTION_PARENT_PAGE_ID");
  if (!token || !parentId) throw new Error("NOTION_TOKEN or HIVEMIND_NOTION_PARENT_PAGE_ID missing");

  const db = openDb("file:data/live-delivery.db");
  await migrate(db.client);
  const gateway = new NotionGateway({ transport: createNotionHttpTransport({ token }) });
  const outbox = new NotionOutbox(db.client);
  const delivery = new NotionStoryPageDelivery(db.client, gateway);

  const cardId = `live-probe-${new Date().toISOString().slice(0, 10)}`;
  const now = Date.now();

  // The delivery bookkeeping tables reference stories, so seed one probe row.
  await db.client.execute({
    sql: `INSERT INTO stories (id, notion_page_id, title, requirement, state, created_at, updated_at)
          VALUES (?, '', 'M1 live delivery probe', 'probe row for block bookkeeping', 'DELIVERED', ?, ?)
          ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    args: [cardId, now, now],
  });

  const created = await gateway.request({
    method: "POST",
    path: "/v1/pages",
    priority: "interaction",
    body: {
      parent: { type: "page_id", page_id: parentId },
      properties: { title: { title: [{ type: "text", text: { content: `M1 live delivery probe ${new Date().toISOString()}` } }] } },
    },
  });
  const pageId = String((created.data as { id: string }).id);
  console.log(`probe page created: ${pageId}`);
  await db.client.execute({
    sql: "UPDATE stories SET notion_page_id = ? WHERE id = ?",
    args: [pageId, cardId],
  });

  const specBlockIds = new Map<string, string>();
  const roundToggles: string[] = [];

  const desiredFor = (round: number) => {
    const specs = [
      { id: "S-LIVE-01", seq: 1, status: round >= 2 ? "passed" : "pending", text: "Probe spec one stays stable across rounds" },
      ...(round >= 3 ? [{ id: "S-LIVE-02", seq: 2, status: round >= 4 ? "passed" : "pending", text: "Probe spec two arrives after round two" }] : []),
    ];
    const verificationRound = round >= 2
      ? { round: round - 1, summary: `probe verify round ${round - 1}` }
      : undefined;
    return {
      metadata: `probe card ${cardId} round ${round}`,
      design: `Probe design produced during round ${round}.`,
      specs,
      ...(verificationRound ? { verificationRound } : {}),
    };
  };

  for (const round of [1, 2, 3, 4]) {
    const payload = { cardId, pageId, desired: desiredFor(round) };
    await outbox.enqueue({
      cardId,
      priority: 2,
      operation: "sync_story_page",
      target: `story-page:${pageId}:round-${round}`,
      payload,
    });
    const result = await outbox.replay(delivery);
    if (result.failed > 0) throw new Error(`round ${round} delivery failed, see notion_outbox.last_error`);
    const errors = await db.client.execute(
      "SELECT id, last_error FROM notion_outbox WHERE state <> 'sent'",
    );
    if (errors.rows.length > 0) throw new Error(`round ${round} left unsent outbox rows`);
    console.log(`round ${round} delivered`);

    const blocks = await listChildren(gateway, pageId);
    const specBlocks = blocks.filter((block) => block.type === "paragraph" && /^S-LIVE-\d+ \[/.test(block.text ?? ""));
    for (const spec of specBlocks) {
      const id = (spec.text ?? "").slice(0, (spec.text ?? "").indexOf(" "));
      const previous = specBlockIds.get(id);
      if (previous && previous !== spec.id) throw new Error(`Spec ${id} block id changed: ${previous} -> ${spec.id}`);
      specBlockIds.set(id, spec.id);
    }
    const toggles = blocks.filter((block) => block.type === "toggle");
    if (toggles.length !== roundToggles.length + (round >= 2 ? 1 : 0)) {
      throw new Error(`round ${round}: verification rounds are not append-only (toggles=${toggles.length})`);
    }
    for (const toggle of toggles) if (!roundToggles.includes(toggle.id)) roundToggles.push(toggle.id);
  }

  console.log("spec block ids stable across all rounds:");
  for (const [id, blockId] of specBlockIds) console.log(`  ${id}: ${blockId}`);
  console.log(`verification toggles appended in order: ${roundToggles.join(", ")}`);

  // M1-22: one real File Upload attach under the metadata callout.
  const evidencePath = join("docs", "poc", "evidence", "m1-live-media-upload.png");
  mkdirSync(join("docs", "poc", "evidence"), { recursive: true });
  const sections = await db.client.execute(
    "SELECT anchor_block_id FROM notion_sections WHERE story_id = ? AND section = 'metadata'",
    [cardId],
  );
  const metadataBlockId = String(sections.rows[0]!.anchor_block_id);
  const media = new NotionMediaPipeline(new NotionGatewayMediaPort(gateway));
  const queued = media.enqueue({
    evidenceId: "live-probe-media-1",
    path: evidencePath,
    targetBlockId: metadataBlockId,
    caption: "M1 live media upload probe",
  });
  const mediaResult = await queued.completion;
  if (mediaResult.kind !== "image") throw new Error(`media upload degraded to placeholder: ${mediaResult.reason ?? "unknown"}`);
  console.log(`media upload attached: upload id ${mediaResult.uploadId}`);
  const calloutChildren = await listChildren(gateway, metadataBlockId);
  const images = calloutChildren.filter((block) => block.type === "image");
  if (images.length !== 1) throw new Error(`expected exactly one image block under the callout, found ${images.length}`);
  console.log(`image block present under metadata callout: ${images[0]!.id}`);
  console.log(`probe page url: https://www.notion.so/${pageId.replaceAll("-", "")}`);

  db.close();
}

main().catch((error: unknown) => {
  console.error(`LIVE PROBE FAILED: ${(error as Error).message}`);
  process.exit(1);
});
