import type { Client } from "@libsql/client";
import { z } from "zod";
import type { NotionGateway } from "./gateway.js";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "./outbox.js";
import { COMMENT_EPIC_PAGE } from "../orchestrator/epic-blocker.js";
import { SYNC_EPIC_STATUS } from "../orchestrator/epic-status-projection.js";
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

const statusSchema = z.object({
  epicId: z.string().min(1),
  status: z.enum(schema.options.epicStatus),
  at: z.number().int(),
});

const commentSchema = z.object({
  epicId: z.string().min(1),
  body: z.string().min(1),
});

/** Every outbox operation this delivery owns, for the replay filter. */
export const EPIC_OUTBOX_OPERATIONS = [
  "present_epic_plan", "create_story_page", SYNC_EPIC_STATUS, COMMENT_EPIC_PAGE,
] as const;

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
    private readonly now: () => number = Date.now,
  ) {}

  async isApplied(record: NotionOutboxRecord): Promise<boolean> {
    if (record.operation === "present_epic_plan") {
      return this.planMarkerPresent(record.target, record.payloadHash);
    }
    if (record.operation === SYNC_EPIC_STATUS) return this.statusApplied(statusSchema.parse(record.payload));
    if (record.operation === COMMENT_EPIC_PAGE) return this.commentPresent(commentSchema.parse(record.payload));
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
    if (record.operation === SYNC_EPIC_STATUS) return this.syncStatus(statusSchema.parse(record.payload));
    if (record.operation === COMMENT_EPIC_PAGE) return this.comment(commentSchema.parse(record.payload));
    throw new Error(`unsupported Epic plan operation: ${record.operation}`);
  }

  /** The comment's own text is the replay marker: the page either carries it or it does not. */
  private async commentPresent(payload: z.infer<typeof commentSchema>): Promise<boolean> {
    const pageId = String((await this.epicRow(payload.epicId)).notion_page_id);
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ block_id: pageId, page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/comments?${query.toString()}`,
        priority: "projection",
      });
      const page = z.object({
        results: z.array(z.object({ rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()) }).passthrough()),
        has_more: z.boolean().optional(),
        next_cursor: z.string().nullable().optional(),
      }).parse(response.data);
      for (const item of page.results) {
        if (item.rich_text.map((part) => part.plain_text).join("") === payload.body) return true;
      }
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return false;
  }

  private async comment(payload: z.infer<typeof commentSchema>): Promise<void> {
    const pageId = String((await this.epicRow(payload.epicId)).notion_page_id);
    await this.gateway.request({
      method: "POST",
      path: "/v1/comments",
      priority: "interaction",
      body: { parent: { page_id: pageId }, rich_text: [text(payload.body)] },
    });
  }

  /**
   * A status the board already shows, or one a human just changed, counts as
   * applied: the first needs no write, and the second must not be overwritten
   * while the human's own change is still what the column means.
   */
  private async statusApplied(payload: z.infer<typeof statusSchema>): Promise<boolean> {
    const epic = await this.epicRow(payload.epicId);
    if (Number(epic.human_wins_until ?? 0) > this.now()) return true;
    const observed = await this.observedStatus(String(epic.notion_page_id));
    if (observed !== payload.status) return false;
    await this.rememberStatus(payload.epicId, payload.status);
    return true;
  }

  private async syncStatus(payload: z.infer<typeof statusSchema>): Promise<void> {
    const epic = await this.epicRow(payload.epicId);
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/pages/${encoded(String(epic.notion_page_id))}`,
      priority: "projection",
      body: { properties: { [schema.propertyNames.epicStatus]: { select: { name: payload.status } } } },
    });
    await this.rememberStatus(payload.epicId, payload.status);
  }

  private async epicRow(epicId: string): Promise<Record<string, unknown>> {
    const row = (await this.client.execute({
      sql: "SELECT notion_page_id, human_wins_until FROM epics WHERE id = ?",
      args: [epicId],
    })).rows[0];
    if (!row) throw new Error(`Epic ${epicId} is not in the central database`);
    return row as Record<string, unknown>;
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
      .safeParse(parsed.data.properties[schema.propertyNames.epicStatus]);
    return select.success ? select.data.select?.name ?? null : null;
  }

  /** The shadow is what tells a later poll that this change was ours, not a
   * human's; without it every projection would read back as a drag. */
  private async rememberStatus(epicId: string, status: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE epics SET notion_status_shadow = ? WHERE id = ?",
      args: [status, epicId],
    });
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
