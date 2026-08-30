import type { Client } from "@libsql/client";
import { z } from "zod";
import type { NotionGateway } from "./gateway.js";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "./outbox.js";
import schema from "./notion-schema.json" with { type: "json" };

const planSchema = z.object({
  epicId: z.string().min(1),
  businessGoal: z.string().min(1),
  stories: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) })).min(1),
  recommendation: z.string().optional(),
});

const storyPageSchema = z.object({
  epicId: z.string().min(1),
  storyId: z.string().min(1),
});

const MARKER_PREFIX = "hivemind-plan:";

function encoded(id: string): string {
  return encodeURIComponent(id);
}

function text(content: string): { type: "text"; text: { content: string } } {
  return { type: "text", text: { content } };
}

function paragraph(content: string): unknown {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [text(content)] } };
}

function heading(content: string): unknown {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [text(content)] } };
}

function bullet(content: string): unknown {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [text(content)] } };
}

function plainText(value: unknown): string {
  const parsed = z.object({ rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()) })
    .safeParse(value);
  return parsed.success ? parsed.data.rich_text.map((item) => item.plain_text).join("") : "";
}

/**
 * The two writes the approval gate depends on. Without them the gate enqueues
 * work no delivery understands, the outbox row stays pending forever, and the
 * human it is waiting on never sees anything.
 */
export class NotionEpicPlanDelivery implements NotionOutboxDelivery {
  constructor(
    private readonly gateway: NotionGateway,
    private readonly client: Client,
    private readonly storiesDataSourceId: string,
  ) {}

  async isApplied(record: NotionOutboxRecord): Promise<boolean> {
    if (record.operation === "present_epic_plan") {
      return this.planMarkerPresent(record.target, record.payloadHash);
    }
    if (record.operation === "create_story_page") {
      const payload = storyPageSchema.parse(record.payload);
      const existing = await this.findStoryPage(payload.storyId);
      if (!existing) return false;
      await this.rememberPageId(payload.storyId, existing);
      return true;
    }
    throw new Error(`unsupported Epic plan operation: ${record.operation}`);
  }

  async send(record: NotionOutboxRecord): Promise<void> {
    if (record.operation === "present_epic_plan") return this.presentPlan(record);
    if (record.operation === "create_story_page") return this.createStoryPage(record);
    throw new Error(`unsupported Epic plan operation: ${record.operation}`);
  }

  private async presentPlan(record: NotionOutboxRecord): Promise<void> {
    const plan = planSchema.parse(record.payload);
    const children = [
      heading("拆解方案"),
      paragraph(plan.businessGoal),
      ...plan.stories.map((story) => bullet(`${story.id} ${story.title}`)),
      ...(plan.recommendation ? [paragraph(plan.recommendation)] : []),
      // Replay marker: the outbox may hand the same plan back after a crash, and
      // an appended plan cannot be diffed the way a property can.
      paragraph(`${MARKER_PREFIX}${record.payloadHash}`),
    ];
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encoded(record.target)}/children`,
      priority: "interaction",
      body: { children },
    });
  }

  private async createStoryPage(record: NotionOutboxRecord): Promise<void> {
    const payload = storyPageSchema.parse(record.payload);
    const story = (await this.client.execute({
      sql: `SELECT s.title, s.requirement, s.repo, s.target_branch, s.priority, e.notion_page_id AS epic_page_id
              FROM stories s LEFT JOIN epics e ON e.id = s.epic_id
             WHERE s.id = ?`,
      args: [payload.storyId],
    })).rows[0];
    if (!story) throw new Error(`Story ${payload.storyId} is not in the central database`);

    const names = schema.propertyNames;
    const properties: Record<string, unknown> = {
      [names.title]: { title: [text(`${payload.storyId} ${String(story.title)}`)] },
      [names.taskId]: { rich_text: [text(payload.storyId)] },
    };
    if (story.repo) properties[names.repository] = { select: { name: String(story.repo) } };
    if (story.target_branch) properties[names.targetBranch] = { rich_text: [text(String(story.target_branch))] };
    if (story.epic_page_id) properties[names.epic] = { relation: [{ id: String(story.epic_page_id) }] };
    const priority = schema.options.priority[Number(story.priority ?? 2)];
    if (priority) properties[names.priority] = { select: { name: priority } };

    const created = await this.gateway.request({
      method: "POST",
      path: "/v1/pages",
      priority: "interaction",
      body: {
        parent: { type: "data_source_id", data_source_id: this.storiesDataSourceId },
        properties,
        children: [heading("需求描述"), paragraph(String(story.requirement))],
      },
    });
    const pageId = z.object({ id: z.string().min(1) }).parse(created.data).id;
    await this.rememberPageId(payload.storyId, pageId);
  }

  private async planMarkerPresent(pageId: string, payloadHash: string): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const suffix = cursor ? `?page_size=100&start_cursor=${encoded(cursor)}` : "?page_size=100";
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/blocks/${encoded(pageId)}/children${suffix}`,
        priority: "projection",
      });
      const page = z.object({
        results: z.array(z.record(z.string(), z.unknown())),
        has_more: z.boolean().optional(),
        next_cursor: z.string().nullable().optional(),
      }).parse(response.data);
      for (const block of page.results) {
        if (plainText(block.paragraph) === `${MARKER_PREFIX}${payloadHash}`) return true;
      }
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return false;
  }

  private async findStoryPage(storyId: string): Promise<string | null> {
    const response = await this.gateway.request({
      method: "POST",
      path: `/v1/data_sources/${encoded(this.storiesDataSourceId)}/query`,
      priority: "projection",
      body: {
        filter: { property: schema.propertyNames.taskId, rich_text: { equals: storyId } },
        page_size: 1,
      },
    });
    const results = z.object({ results: z.array(z.object({ id: z.string() }).passthrough()) })
      .parse(response.data).results;
    return results[0]?.id ?? null;
  }

  /** The gate inserts Stories with a synthetic page id so the row can exist
   * before Notion does; this is where the real one lands. */
  private async rememberPageId(storyId: string, pageId: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE stories SET notion_page_id = ? WHERE id = ? AND notion_page_id <> ?",
      args: [pageId, storyId, pageId],
    });
  }
}
