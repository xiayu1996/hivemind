// Live Notion acceptance probe: drives consecutive Story page delivery rounds
// with one real File Upload attachment, then an Epic page through two rounds,
// against the bootstrapped workspace. Prints only page/block identifiers,
// never tokens. Every page it creates is archived again except the Story probe
// page, whose block ids the run reports for inspection.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSecretsFile } from "../src/config/secrets-file.js";
import { NotionGateway } from "../src/notion/gateway.js";
import { NotionMediaPipeline } from "../src/notion/media.js";
// oxlint-disable unicorn/no-thenable -- Given/When/Then is the external DoD contract.
import { NotionOutbox } from "../src/notion/outbox.js";
import { NotionStoryPageDelivery } from "../src/notion/story-page-delivery.js";
import { NotionEpicPlanDelivery } from "../src/notion/epic-plan-delivery.js";
import { epicPagePayload, epicPageStatement } from "../src/orchestrator/epic-page-projection.js";
import {
  NotionGatewayMediaPort,
  createNotionHttpTransport,
} from "../src/notion/sdk-adapters.js";
import schema from "../src/notion/notion-schema.json" with { type: "json" };
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
  const storyPageId = await storyProbe(db, gateway, parentId);
  await epicProbe(db, gateway, secrets, storyPageId);
  db.close();
}

async function storyProbe(
  db: ReturnType<typeof openDb>,
  gateway: NotionGateway,
  parentId: string,
): Promise<string> {
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

  // The scenario detail hangs off the central rows, so the probe seeds them.
  for (const [seq, specId] of [[1, "S-LIVE-01-a"], [2, "S-LIVE-01-b"]] as Array<[number, string]>) {
    await db.client.execute({
      sql: `INSERT INTO story_specs (spec_id, story_id, seq, text, status)
            VALUES (?, ?, ?, 'probe', 'pending')
            ON CONFLICT(spec_id) DO NOTHING`,
      args: [specId, cardId, seq],
    });
  }

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
      {
        id: "S-LIVE-01-a",
        seq: 1,
        status: round >= 2 ? "passed" : "pending",
        title: "\u63a2\u9488\u573a\u666f\u4e00\u8de8\u8f6e\u4e0d\u6362\u5757",
        given: "\u63a2\u9488\u9875\u5df2\u5efa\u597d",
        when: "\u53c8\u6295\u4e00\u8f6e",
        then: "\u8fd9\u4e00\u884c\u8fd8\u662f\u540c\u4e00\u4e2a\u5757",
        layers: ["integration"],
      },
      ...(round >= 3
        ? [{
            id: "S-LIVE-01-b",
            seq: 2,
            status: round >= 4 ? "passed" : "pending",
            title: "\u63a2\u9488\u573a\u666f\u4e8c\u7b2c\u4e09\u8f6e\u624d\u51fa\u73b0",
            given: "\u524d\u4e24\u8f6e\u6ca1\u6709\u5b83",
            when: "\u7b2c\u4e09\u8f6e\u6295\u5f71",
            then: "\u5b83\u63d2\u5728\u7b2c\u4e00\u6761\u540e\u9762",
            layers: ["e2e"],
          }]
        : []),
    ];
    const verificationRound = round >= 2
      ? {
          round: round - 1,
          at: Date.now(),
          verdict: round % 2 === 0 ? "rejected" : "accepted",
          passed: round % 2 === 0 ? 0 : specs.length,
          total: specs.length,
          rows: specs.map((spec) => ({
            scenario: `\u573a\u666f ${spec.seq} \u00b7 ${spec.title}`,
            test: round % 2 === 0 ? "\u672a\u901a\u8fc7" : "\u901a\u8fc7",
            screen: "\u2014",
            note: "\u63a2\u9488\u5199\u7684\u4e00\u53e5\u8bdd",
          })),
          findings: ["\u63a2\u9488\u754c\u9762\u5efa\u8bae\uff0c\u4e0d\u5f71\u54cd\u9a8c\u6536"],
        }
      : undefined;
    return {
      metadata: `\u63a2\u9488\u5361 ${cardId} \u7b2c ${round} \u8f6e\uff1a\u56de\u590d\u672c\u9875\u8bc4\u8bba\u5373\u53ef`,
      design: `\u7b2c ${round} \u8f6e\u5199\u51fa\u6765\u7684\u8bbe\u8ba1\u6458\u8981\u3002`,
      specs,
      technical: [`\u63a2\u9488\u7b2c ${round} \u8f6e\u7684\u6280\u672f\u7ec6\u8282`],
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
    const specBlocks = blocks.filter((block) => block.type === "paragraph" && /S-LIVE-01-[ab]/.test(block.text ?? ""));
    for (const spec of specBlocks) {
      const id = /S-LIVE-01-[ab]/.exec(spec.text ?? "")![0];
      const previous = specBlockIds.get(id);
      if (previous && previous !== spec.id) throw new Error(`Spec ${id} block id changed: ${previous} -> ${spec.id}`);
      specBlockIds.set(id, spec.id);
    }
    const toggles = blocks.filter((block) => block.type === "toggle" && /^\u7b2c \d+ \u8f6e/.test(block.text ?? ""));
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
  return pageId;
}


/**
 * The Epic page through two rounds: a page an older build left with a progress
 * section, then the batch it carries, then the same page once the Stories have
 * pages of their own and the Epic has an MR.
 */
async function epicProbe(
  db: ReturnType<typeof openDb>,
  gateway: NotionGateway,
  secrets: Awaited<ReturnType<typeof loadSecretsFile>>,
  storyPageId: string,
): Promise<void> {
  const epicsDataSourceId = secrets.get("HIVEMIND_NOTION_EPICS_DATA_SOURCE_ID");
  const storiesDataSourceId = secrets.get("HIVEMIND_NOTION_STORIES_DATA_SOURCE_ID");
  if (!epicsDataSourceId || !storiesDataSourceId) throw new Error("the Epics or Stories data source id is missing");
  const day = new Date().toISOString().slice(0, 10);
  const requirementId = `R-LIVE-${day}`;
  const epicId = `ELIVE${day.replaceAll("-", "")}`;
  const now = Date.now();
  const prd = JSON.stringify({
    businessGoal: "\u8ba9\u4eba\u4e00\u6b21\u9a8c\u6536\u4e00\u6279\u4ea4\u4ed8",
    nonGoals: [],
    scenarios: [
      { id: "s01", given: "\u7ba1\u7406\u5458\u6253\u5f00\u89c4\u5219\u9875", when: "\u4fdd\u5b58\u4e00\u6761\u89c4\u5219", then: "\u5217\u8868\u91cc\u51fa\u73b0\u5b83" },
      { id: "s02", given: "\u5220\u6389\u89c4\u5219", when: "\u5237\u65b0\u9875\u9762", then: "\u5217\u8868\u91cc\u6ca1\u6709\u5b83" },
    ],
  });

  const created = await gateway.request({
    method: "POST",
    path: "/v1/pages",
    priority: "interaction",
    body: {
      parent: { type: "data_source_id", data_source_id: epicsDataSourceId },
      properties: {
        [schema.propertyNames.title]: {
          title: [{ type: "text", text: { content: `Epic \u9875\u63a2\u9488 ${new Date().toISOString()}` } }],
        },
        [schema.propertyNames.taskId]: { rich_text: [{ type: "text", text: { content: epicId } }] },
      },
      children: [
        { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "\u8fd9\u4e00\u6279\u8981\u505a\u4ec0\u4e48" } }] } },
        // What an older build left behind, which this page no longer has.
        { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "\u8fdb\u5c55" } }] } },
        { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "S-LIVE-01 \u63a2\u9488 \u2014 \u5f00\u53d1\u4e2d" } }] } },
      ],
    },
  });
  const epicPageId = String((created.data as { id: string }).id);
  console.log(`epic probe page created: ${epicPageId}`);

  await db.client.batch([
    {
      sql: `INSERT INTO requirements (id, notion_page_id, title, state, original_request, created_at, updated_at)
            VALUES (?, ?, '\u63a2\u9488\u9700\u6c42', 'EXECUTING', '\u63a2\u9488', ?, ?)
            ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      args: [requirementId, `req-${epicId}`, now, now],
    },
    {
      sql: `INSERT INTO requirement_prds (requirement_id, revision, body, status, created_at, confirmed_at)
            VALUES (?, 1, ?, 'confirmed', ?, ?)
            ON CONFLICT(requirement_id, revision) DO UPDATE SET body = excluded.body`,
      args: [requirementId, prd, now, now],
    },
    {
      sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, business_goal,
                               integration_branch, created_at, updated_at)
            VALUES (?, ?, 'Epic \u9875\u63a2\u9488', 'EXECUTING', ?, '\u8ba9\u4eba\u4e00\u6b21\u9a8c\u6536\u4e00\u6279\u4ea4\u4ed8', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET notion_page_id = excluded.notion_page_id, updated_at = excluded.updated_at`,
      args: [epicId, epicPageId, requirementId, `epic/${epicId}`, now, now],
    },
    {
      sql: `INSERT INTO epic_prd_scenarios (requirement_id, epic_id, prd_scenario_id) VALUES (?, ?, 's01')
            ON CONFLICT(requirement_id, prd_scenario_id) DO UPDATE SET epic_id = excluded.epic_id`,
      args: [requirementId, epicId],
    },
    {
      sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, created_at, updated_at)
            VALUES (?, ?, ?, '\u63a2\u9488\u573a\u666f\u4e00', '\u63a2\u9488', 'CODE', ?, ?)
            ON CONFLICT(id) DO UPDATE SET epic_id = excluded.epic_id`,
      args: [`S-${epicId}-01`, epicId, `pending-${epicId}-01`, now, now],
    },
    {
      sql: `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, depends_on, created_at, updated_at)
            VALUES (?, ?, ?, '\u63a2\u9488\u573a\u666f\u4e8c', '\u63a2\u9488', 'QUEUED', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET epic_id = excluded.epic_id`,
      args: [`S-${epicId}-02`, epicId, `pending-${epicId}-02`, JSON.stringify([`S-${epicId}-01`]), now, now],
    },
  ], "write");

  const outbox = new NotionOutbox(db.client);
  const delivery = new NotionEpicPlanDelivery(gateway, db.client, storiesDataSourceId);
  const project = async (round: number): Promise<void> => {
    const payload = await epicPagePayload(db.client, epicId);
    if (!payload) throw new Error("the probe Epic has no payload");
    await db.client.execute(epicPageStatement(payload, Date.now()));
    const result = await outbox.replay(delivery);
    if (result.failed > 0) throw new Error(`epic round ${round} delivery failed, see notion_outbox.last_error`);
    console.log(`epic round ${round} delivered`);
  };

  // The plan a person approved, then the page the projection owns.
  await outbox.enqueue({
    cardId: epicId,
    priority: 1,
    operation: "present_epic_plan",
    target: epicPageId,
    payload: {
      epicId,
      businessGoal: "\u8ba9\u4eba\u4e00\u6b21\u9a8c\u6536\u4e00\u6279\u4ea4\u4ed8",
      stories: [
        { id: `S-${epicId}-01`, title: "\u63a2\u9488\u573a\u666f\u4e00" },
        { id: `S-${epicId}-02`, title: "\u63a2\u9488\u573a\u666f\u4e8c" },
      ],
    },
  });
  await project(1);
  const planBlocks = (await listChildren(gateway, epicPageId))
    .filter((block) => block.type === "bulleted_list_item" && (block.text ?? "").includes(`S-${epicId}-01`))
    .map((block) => block.id);
  if (planBlocks.length !== 1) throw new Error(`expected one plan line for the first Story, found ${planBlocks.length}`);

  // The Story now has a page and the Epic an MR: the plan line becomes a link
  // and the technical fold gains the review request, both in place.
  await db.client.batch([
    {
      // The Story probe row above holds this page, and a page belongs to one
      // Story; the probe hands it over rather than claiming it twice.
      sql: "UPDATE stories SET notion_page_id = 'retired-' || id WHERE notion_page_id = ?",
      args: [storyPageId],
    },
    {
      sql: "UPDATE stories SET notion_page_id = ? WHERE id = ?",
      args: [storyPageId, `S-${epicId}-01`],
    },
    {
      sql: "UPDATE epics SET mr_url = ?, state = 'EPIC_ACCEPT' WHERE id = ?",
      args: [`https://example.test/pull/${day.replaceAll("-", "")}`, epicId],
    },
  ], "write");
  await project(2);

  const blocks = await listChildren(gateway, epicPageId);
  const headings = blocks.filter((block) => block.type === "heading_2").map((block) => block.text ?? "");
  const expected = ["\u76ee\u6807", "\u62c6\u89e3\u65b9\u6848", "\u4f9d\u8d56", "\u6280\u672f\u7ec6\u8282"];
  if (headings.join("|") !== expected.join("|")) {
    throw new Error(`epic headings are wrong or duplicated: ${headings.join(" / ")}`);
  }
  if (blocks.filter((block) => block.type === "callout").length !== 1) {
    throw new Error("the Epic page does not carry exactly one callout");
  }
  const planLine = blocks.find((block) => block.id === planBlocks[0]);
  if (!planLine) throw new Error("the approved plan line was replaced instead of rewritten");
  if (!(planLine.text ?? "").includes("\u63a2\u9488\u573a\u666f\u4e00")) {
    throw new Error(`the plan line lost its words: ${planLine.text ?? ""}`);
  }
  console.log(`epic headings in order: ${headings.join(" / ")}`);
  console.log(`plan line kept its block and now mentions the Story page: ${planLine.id}`);

  // The board is not a place to leave probes, unless the run was asked to
  // leave this one there to be looked at.
  if (process.env.HIVEMIND_PROBE_KEEP === "1") {
    console.log(`epic probe page kept: https://www.notion.so/${epicPageId.replaceAll("-", "")}`);
    return;
  }
  await gateway.request({
    method: "PATCH",
    path: `/v1/pages/${encodeURIComponent(epicPageId)}`,
    priority: "interaction",
    body: { archived: true },
  });
  console.log("epic probe page archived");
}

main().catch((error: unknown) => {
  console.error(`LIVE PROBE FAILED: ${(error as Error).message}`);
  process.exit(1);
});
