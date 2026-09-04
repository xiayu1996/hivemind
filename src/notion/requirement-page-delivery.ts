import type { Client } from "@libsql/client";
import { z } from "zod";
import {
  REQUIREMENT_SECTION_ORDER,
  planRequirementPageUpdate,
  type RequirementPageOperation,
  type RequirementPageSnapshot,
  type RequirementSection,
} from "./blocks/requirement-page.js";
import type { NotionGateway } from "./gateway.js";
import { shouldSuppressSystemProjection } from "./intent-interpreter.js";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "./outbox.js";
import schema from "./notion-schema.json" with { type: "json" };

const SECTION_TITLES: Record<RequirementSection, string> = {
  metadata: "元信息",
  original: "原始需求",
  clarify: "澄清记录",
  prd: "PRD",
  acceptance: "场景化验收清单",
};
const TITLE_SECTIONS = new Map(
  Object.entries(SECTION_TITLES).map(([section, title]) => [title, section as RequirementSection]),
);

const desiredSchema = z.object({
  metadata: z.string(),
  original: z.string(),
  clarify: z.array(z.string()),
  prd: z.array(z.string()),
  prdFrozen: z.boolean(),
  acceptance: z.array(z.string()),
});
const pageSchema = z.object({
  requirementId: z.string().min(1),
  pageId: z.string().min(1),
  status: z.string().min(1),
  desired: desiredSchema,
});
const epicPageSchema = z.object({
  requirementId: z.string().min(1),
  epicId: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  scenarioIds: z.array(z.string()),
});
const blockSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  archived: z.boolean().optional(),
}).passthrough();
const listSchema = z.object({
  results: z.array(blockSchema),
  has_more: z.boolean().default(false),
  next_cursor: z.string().nullable().default(null),
}).passthrough();

type NotionBlock = z.infer<typeof blockSchema>;

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function text(content: string): { type: "text"; text: { content: string } } {
  return { type: "text", text: { content } };
}

function richText(content: string): Array<{ type: "text"; text: { content: string } }> {
  if (content.length > 2_000) throw new Error("Notion block content exceeds the 2000 character limit");
  return [text(content)];
}

function blockBody(type: "paragraph" | "callout" | "to_do" | "heading_2", content: string): Record<string, unknown> {
  return {
    object: "block",
    type,
    [type]: {
      rich_text: richText(content),
      ...(type === "callout" ? { icon: { type: "emoji", emoji: "ℹ️" } } : {}),
      // The tick belongs to the person; a projection only ever creates the box.
      ...(type === "to_do" ? { checked: false } : {}),
    },
  };
}

function textOf(item: NotionBlock): string {
  const value = item[item.type];
  const parsed = z.object({ rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()) })
    .passthrough().safeParse(value);
  return parsed.success ? parsed.data.rich_text.map((part) => part.plain_text).join("") : "";
}

/** Every outbox operation this delivery owns, for the replay filter. */
export const REQUIREMENT_OUTBOX_OPERATIONS = ["sync_requirement_page", "create_epic_page"] as const;

/**
 * The requirement page is the whole human interface of the product manager
 * layer: what was asked, what was asked back, what was agreed, and what is
 * still to be judged. Everything here is a projection of the database, except
 * the two things a person owns — their original words and their ticks.
 */
export class NotionRequirementPageDelivery implements NotionOutboxDelivery {
  constructor(
    private readonly client: Client,
    private readonly gateway: NotionGateway,
    private readonly epicsDataSourceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async isApplied(record: NotionOutboxRecord): Promise<boolean> {
    if (record.operation === "sync_requirement_page") {
      const payload = pageSchema.parse(record.payload);
      const snapshot = await this.readPage(payload.pageId);
      await this.rememberAnchors(payload.requirementId, snapshot);
      if (planRequirementPageUpdate(snapshot, payload.desired).length > 0) return false;
      return await this.observedStatus(payload.pageId) === payload.status;
    }
    if (record.operation === "create_epic_page") {
      const payload = epicPageSchema.parse(record.payload);
      const existing = await this.findEpicPage(payload.epicId);
      if (!existing) return false;
      await this.rememberEpicPageId(payload.epicId, existing);
      return true;
    }
    throw new Error(`unsupported requirement outbox operation: ${record.operation}`);
  }

  async send(record: NotionOutboxRecord): Promise<void> {
    if (record.operation === "sync_requirement_page") return this.syncPage(record);
    if (record.operation === "create_epic_page") return this.createEpicPage(record);
    throw new Error(`unsupported requirement outbox operation: ${record.operation}`);
  }

  private async syncPage(record: NotionOutboxRecord): Promise<void> {
    const payload = pageSchema.parse(record.payload);
    for (let pass = 0; pass < 8; pass++) {
      const snapshot = await this.readPage(payload.pageId);
      await this.rememberAnchors(payload.requirementId, snapshot);
      await this.bindAcceptanceBlocks(payload.requirementId, snapshot);
      const operations = planRequirementPageUpdate(snapshot, payload.desired);
      if (operations.length === 0) break;
      await this.apply(payload.pageId, snapshot, operations);
    }
    await this.syncStatus(payload.requirementId, payload.pageId, payload.status);
  }

  private async apply(
    pageId: string,
    snapshot: RequirementPageSnapshot,
    operations: readonly RequirementPageOperation[],
  ): Promise<void> {
    const missingSections = operations.flatMap((operation) =>
      operation.type === "create_section" ? [operation.section] : []);
    if (missingSections.length > 0) {
      // Headings are appended in the canonical order so a page built in several
      // passes still reads top to bottom the way the design lays it out.
      const ordered = REQUIREMENT_SECTION_ORDER.filter((section) => missingSections.includes(section));
      await this.gateway.request({
        method: "PATCH",
        path: `/v1/blocks/${encoded(pageId)}/children`,
        priority: "projection",
        body: { children: ordered.map((section) => blockBody("heading_2", SECTION_TITLES[section])) },
      });
      return;
    }

    for (const operation of operations) {
      if (operation.type === "archive_block") {
        await this.gateway.request({
          method: "PATCH",
          path: `/v1/blocks/${encoded(operation.blockId)}`,
          priority: "projection",
          body: { archived: true },
        });
      }
      if (operation.type === "update_block") {
        const type = snapshot.sections.metadata?.blocks[0]?.id === operation.blockId ? "callout" : "paragraph";
        await this.gateway.request({
          method: "PATCH",
          path: `/v1/blocks/${encoded(operation.blockId)}`,
          priority: "projection",
          body: { [type]: { rich_text: richText(operation.content) } },
        });
      }
    }

    const inserts = operations.filter((operation) => operation.type === "insert");
    for (const section of REQUIREMENT_SECTION_ORDER) {
      const batch = inserts.filter((operation) => operation.section === section);
      if (batch.length === 0) continue;
      const after = batch[0]!.afterBlockId;
      await this.gateway.request({
        method: "PATCH",
        path: `/v1/blocks/${encoded(pageId)}/children`,
        priority: "projection",
        body: {
          children: batch.map((operation) => blockBody(operation.block, operation.content)),
          ...(after ? { after } : {}),
        },
      });
    }
  }

  /** The board column is a shared field: a person who just moved it wins for
   * two minutes, exactly as on a Story. */
  private async syncStatus(requirementId: string, pageId: string, status: string): Promise<void> {
    const row = (await this.client.execute({
      sql: "SELECT last_human_action_at FROM requirements WHERE id = ?",
      args: [requirementId],
    })).rows[0];
    const lastHumanActionAt = Number(row?.last_human_action_at ?? 0);
    if (lastHumanActionAt > 0 && shouldSuppressSystemProjection(lastHumanActionAt, this.now())) return;
    if (await this.observedStatus(pageId) === status) return;
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/pages/${encoded(pageId)}`,
      priority: "projection",
      body: { properties: { [schema.propertyNames.requirementStatus]: { select: { name: status } } } },
    });
    await this.client.execute({
      sql: "UPDATE requirements SET notion_status_shadow = ?, updated_at = ? WHERE id = ?",
      args: [status, this.now(), requirementId],
    });
  }

  private async observedStatus(pageId: string): Promise<string | null> {
    const response = await this.gateway.request({
      method: "GET",
      path: `/v1/pages/${encoded(pageId)}`,
      priority: "projection",
    });
    const parsed = z.object({ properties: z.record(z.string(), z.unknown()) }).passthrough().safeParse(response.data);
    if (!parsed.success) return null;
    const select = z.object({ select: z.object({ name: z.string() }).nullable() })
      .safeParse(parsed.data.properties[schema.propertyNames.requirementStatus]);
    return select.success ? select.data.select?.name ?? null : null;
  }

  private async readPage(pageId: string): Promise<RequirementPageSnapshot> {
    const sections: RequirementPageSnapshot["sections"] = {};
    let current: RequirementSection | undefined;
    let cursor: string | undefined;
    do {
      const suffix = cursor ? `?page_size=100&start_cursor=${encoded(cursor)}` : "?page_size=100";
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/blocks/${encoded(pageId)}/children${suffix}`,
        priority: "projection",
      });
      const page = listSchema.parse(response.data);
      for (const block of page.results) {
        if (block.archived) continue;
        if (block.type === "heading_2") {
          const section = TITLE_SECTIONS.get(textOf(block));
          current = section;
          if (section) sections[section] = { anchorBlockId: block.id, blocks: [] };
          continue;
        }
        const holder = current ? sections[current] : undefined;
        if (!current || !holder) continue;
        sections[current] = {
          anchorBlockId: holder.anchorBlockId,
          blocks: [...holder.blocks, { id: block.id, content: textOf(block) }],
        };
      }
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return { sections };
  }

  private async rememberAnchors(requirementId: string, snapshot: RequirementPageSnapshot): Promise<void> {
    for (const [section, holder] of Object.entries(snapshot.sections)) {
      if (!holder) continue;
      await this.client.execute({
        sql: `INSERT INTO requirement_notion_sections (requirement_id, section, anchor_block_id)
              VALUES (?, ?, ?)
              ON CONFLICT(requirement_id, section) DO UPDATE SET anchor_block_id = excluded.anchor_block_id`,
        args: [requirementId, section, holder.anchorBlockId],
      });
    }
  }

  /** Ties each checklist box to the scenario it stands for, so a tick can be
   * read back as a verdict on that scenario and not merely as a tick. */
  private async bindAcceptanceBlocks(requirementId: string, snapshot: RequirementPageSnapshot): Promise<void> {
    const blocks = snapshot.sections.acceptance?.blocks ?? [];
    for (const block of blocks) {
      await this.client.execute({
        sql: `UPDATE requirement_acceptance_items SET notion_block_id = ?
              WHERE requirement_id = ? AND text = ? AND (notion_block_id IS NULL OR notion_block_id <> ?)`,
        args: [block.id, requirementId, block.content, block.id],
      });
    }
  }

  private async createEpicPage(record: NotionOutboxRecord): Promise<void> {
    const payload = epicPageSchema.parse(record.payload);
    const requirement = (await this.client.execute({
      sql: "SELECT notion_page_id FROM requirements WHERE id = ?",
      args: [payload.requirementId],
    })).rows[0];
    if (!requirement) throw new Error(`requirement ${payload.requirementId} is not in the central database`);

    const names = schema.propertyNames;
    const properties: Record<string, unknown> = {
      [names.title]: { title: [text(payload.title)] },
      [names.epicStatus]: { select: { name: schema.options.epicStatus[0] } },
      [names.requirementRelation]: { relation: [{ id: String(requirement.notion_page_id) }] },
    };
    const created = await this.gateway.request({
      method: "POST",
      path: "/v1/pages",
      priority: "interaction",
      body: {
        parent: { type: "data_source_id", data_source_id: this.epicsDataSourceId },
        properties,
        children: payload.body.split("\n\n").map((part) => blockBody("paragraph", part)),
      },
    });
    const pageId = z.object({ id: z.string().min(1) }).parse(created.data).id;
    await this.rememberEpicPageId(payload.epicId, pageId);
  }

  private async findEpicPage(epicId: string): Promise<string | null> {
    const response = await this.gateway.request({
      method: "POST",
      path: `/v1/data_sources/${encoded(this.epicsDataSourceId)}/query`,
      priority: "projection",
      body: {
        filter: { property: schema.propertyNames.title, title: { starts_with: `${epicId} ` } },
        page_size: 1,
      },
    });
    const results = z.object({ results: z.array(z.object({ id: z.string() }).passthrough()) })
      .parse(response.data).results;
    return results[0]?.id ?? null;
  }

  /** The decomposition inserts Epics with a synthetic page id so the row can
   * exist before Notion does; this is where the real one lands. */
  private async rememberEpicPageId(epicId: string, pageId: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE epics SET notion_page_id = ? WHERE id = ? AND notion_page_id <> ?",
      args: [pageId, epicId, pageId],
    });
  }
}
