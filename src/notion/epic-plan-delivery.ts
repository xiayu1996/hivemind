import type { Client } from "@libsql/client";
import { z } from "zod";
import type { NotionGateway } from "./gateway.js";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "./outbox.js";
import { COMMENT_EPIC_PAGE } from "../orchestrator/epic-blocker.js";
import { SYNC_EPIC_STATUS } from "../orchestrator/epic-status-projection.js";
import { SYNC_EPIC_PAGE, renderEpicPage, type EpicPagePayload } from "../orchestrator/epic-page-projection.js";
import pageText from "../orchestrator/epic-page-text.json" with { type: "json" };
import schema from "./notion-schema.json" with { type: "json" };
import { bullet as richBullet, code, heading2, pageMention, runs, t, type Block } from "./rich-text.js";
import { epicSectionForTitle, epicSectionTitle, quietText, sectionTitle } from "./display-text.js";

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

const pageSchema = z.object({
  epicId: z.string().min(1),
  state: z.string().min(1),
  status: z.enum(schema.options.epicStatus),
  mrUrl: z.string().nullable(),
  targetBranch: z.string().min(1),
  integrationBranch: z.string().nullable(),
  businessGoal: z.string().nullable(),
  prdScenarios: z.array(z.object({ id: z.string().min(1), text: z.string() })),
  stories: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    pageId: z.string().nullable(),
    dependsOn: z.array(z.string()),
  })),
}) as unknown as z.ZodType<EpicPagePayload>;

const commentSchema = z.object({
  epicId: z.string().min(1),
  body: z.string().min(1),
});

/** Every outbox operation this delivery owns, for the replay filter. */
export const EPIC_OUTBOX_OPERATIONS = [
  "present_epic_plan", "create_story_page", SYNC_EPIC_STATUS, COMMENT_EPIC_PAGE, SYNC_EPIC_PAGE,
] as const;

// Older projections printed the replay key as a line on the page. The key
// lives in `epic_notion_sections` now; these prefixes are only how such a
// line is recognised so it can be removed when the page is next written.
const LEGACY_MARKER_PREFIXES = ["hivemind-plan:", "hivemind-progress:"] as const;

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

function calloutBlock(quiet: { icon: string; color: string; action: string }): unknown {
  return {
    object: "block",
    type: "callout",
    callout: { rich_text: [text(quiet.action)], icon: { type: "emoji", emoji: quiet.icon }, color: quiet.color },
  };
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
      const payload = planSchema.parse(record.payload);
      return this.sectionApplied(payload.epicId, "plan", record.target, record.payloadHash);
    }
    if (record.operation === SYNC_EPIC_STATUS) return this.statusApplied(statusSchema.parse(record.payload));
    if (record.operation === SYNC_EPIC_PAGE) {
      const payload = pageSchema.parse(record.payload);
      const pageId = String((await this.epicRow(payload.epicId)).notion_page_id);
      return this.sectionApplied(payload.epicId, "page", pageId, record.payloadHash);
    }
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
    if (record.operation === SYNC_EPIC_PAGE) return this.syncPage(pageSchema.parse(record.payload), record.payloadHash);
    if (record.operation === COMMENT_EPIC_PAGE) return this.comment(commentSchema.parse(record.payload));
    throw new Error(`unsupported Epic plan operation: ${record.operation}`);
  }

  /**
   * The page a person opens to decide whether this batch is what they asked
   * for: what it carries, how it was cut up, and how to review it. Where each
   * Story stands is deliberately absent -- that is the board's job, and a page
   * that repeated it would be wrong within the minute.
   */
  private async syncPage(payload: EpicPagePayload, payloadHash: string): Promise<void> {
    const epic = await this.epicRow(payload.epicId);
    const pageId = String(epic.notion_page_id);
    const properties: Record<string, unknown> = {
      [schema.propertyNames.mergeRequest]: { url: payload.mrUrl },
      // Fills the id column on pages created before it existed, so the board
      // and the intake lookup stop depending on the title prefix.
      [schema.propertyNames.taskId]: { rich_text: [text(payload.epicId)] },
    };
    // A column a person just dragged keeps their word until the human-wins
    // window closes, exactly as the status-only projection does.
    const humanWins = Number(epic.human_wins_until ?? 0) > this.now();
    if (!humanWins) properties[schema.propertyNames.epicStatus] = { select: { name: payload.status } };
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/pages/${encoded(pageId)}`,
      priority: "projection",
      body: { properties },
    });
    if (!humanWins) await this.rememberStatus(payload.epicId, payload.status);

    const rendered = renderEpicPage(payload);
    let blocks = await this.children(pageId);
    // The sections this projection owns are rebuilt whole, so everything they
    // currently hold goes first -- together with the progress section an older
    // build wrote, which this page no longer has, and the replay markers older
    // builds printed as text.
    const stale = new Set<string>([
      ...this.ownedSectionBlocks(blocks),
      ...this.sectionBlocks(blocks, pageText.legacyProgressHeading),
      ...blocks
        .filter((block) => LEGACY_MARKER_PREFIXES.some((prefix) => plainText(block.paragraph).startsWith(prefix)))
        .map((block) => String(block.id)),
    ]);
    for (const blockId of stale) {
      await this.gateway.request({ method: "DELETE", path: `/v1/blocks/${encoded(blockId)}`, priority: "projection" });
    }
    if (stale.size > 0) blocks = blocks.filter((block) => !stale.has(String(block.id)));

    const calloutId = await this.writeCallout(pageId, blocks, rendered.callout);
    await this.writeSections(pageId, blocks, rendered.sections, calloutId);
    await this.mentionStoryPages(blocks, payload);
    await this.rememberSection(payload.epicId, "page", payloadHash);
  }

  /** The callout keeps its block: it can only be appended after another one,
   * so archiving it on a quiet day would bring it back at the bottom. */
  private async writeCallout(
    pageId: string,
    blocks: Array<Record<string, unknown>>,
    callout: { content: string; icon: string; color: string },
  ): Promise<string | undefined> {
    const existing = blocks.find((block) => String(block.type) === "callout");
    const body = {
      rich_text: t(callout.content),
      icon: { type: "emoji", emoji: callout.icon },
      color: callout.color,
    };
    if (existing) {
      if (plainText(existing.callout) !== callout.content) {
        await this.gateway.request({
          method: "PATCH",
          path: `/v1/blocks/${encoded(String(existing.id))}`,
          priority: "projection",
          body: { callout: body },
        });
      }
      return String(existing.id);
    }
    const [created] = await this.append(
      pageId,
      [{ object: "block", type: "callout", callout: body }],
      blocks[0] ? String(blocks[0].id) : undefined,
    );
    return created;
  }

  /**
   * Each owned section lands where a reader expects it: the goal above the
   * plan a person approved, the rest below it. Notion can only append after a
   * block, so each section is anchored on the last block written before it.
   */
  private async writeSections(
    pageId: string,
    blocks: Array<Record<string, unknown>>,
    sections: ReturnType<typeof renderEpicPage>["sections"],
    calloutId: string | undefined,
  ): Promise<void> {
    const planBlocks = this.sectionBlocks(blocks, epicSectionTitle("plan"));
    // The goal follows the callout, which is the block a reader meets first.
    const first = calloutId ?? (blocks[0] ? String(blocks[0].id) : undefined);
    let afterGoal = planBlocks.at(-1) ?? first;
    let anchor: string | undefined = first;
    for (const { section, blocks: children } of sections) {
      if (children.length === 0) continue;
      const after = section === "goal" ? anchor : afterGoal;
      const created = await this.append(
        pageId,
        [heading2(t(epicSectionTitle(section))), ...children],
        after,
      );
      const last = created.at(-1);
      if (!last) continue;
      if (section === "goal") anchor = last;
      else afterGoal = last;
    }
  }

  private async append(pageId: string, children: Block[], after?: string): Promise<string[]> {
    const response = await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encoded(pageId)}/children`,
      priority: "projection",
      body: { children, ...(after ? { after } : {}) },
    });
    return z.object({ results: z.array(z.object({ id: z.string() }).passthrough()) })
      .parse(response.data).results.map((block) => block.id);
  }

  /**
   * A Story line in the approved plan becomes a link once the Story has a
   * page. The block is rewritten rather than replaced: a person may have
   * commented on the line they approved.
   */
  private async mentionStoryPages(
    blocks: Array<Record<string, unknown>>,
    payload: EpicPagePayload,
  ): Promise<void> {
    const planBlocks = new Set(this.sectionBlocks(blocks, epicSectionTitle("plan")));
    for (const story of payload.stories) {
      if (!story.pageId) continue;
      const line = blocks.find((block) => planBlocks.has(String(block.id))
        && String(block.type) === "bulleted_list_item"
        && plainText(block.bulleted_list_item).includes(story.id));
      if (!line) continue;
      const current = plainText(line.bulleted_list_item);
      if (!current.includes(story.id)) continue;
      await this.gateway.request({
        method: "PATCH",
        path: `/v1/blocks/${encoded(String(line.id))}`,
        priority: "projection",
        body: { bulleted_list_item: { rich_text: runs(t(`${story.title} `), pageMention(story.pageId)) } },
      });
    }
  }

  /** Every block under a heading this projection owns, the heading included. */
  private ownedSectionBlocks(blocks: Array<Record<string, unknown>>): string[] {
    const ids: string[] = [];
    let inside = false;
    for (const block of blocks) {
      if (String(block.type ?? "") === "heading_2") {
        const section = epicSectionForTitle(plainText(block.heading_2));
        inside = section !== undefined && section !== "plan";
        if (!inside) continue;
      }
      if (inside) ids.push(String(block.id));
    }
    return ids;
  }

  /** A named heading and every block after it up to the next heading. */
  private sectionBlocks(blocks: Array<Record<string, unknown>>, title: string): string[] {
    const ids: string[] = [];
    let inside = false;
    for (const block of blocks) {
      if (String(block.type ?? "") === "heading_2") {
        inside = plainText(block.heading_2) === title;
        if (!inside) continue;
      }
      if (inside) ids.push(String(block.id));
    }
    return ids;
  }

  private async children(pageId: string): Promise<Array<Record<string, unknown>>> {
    const blocks: Array<Record<string, unknown>> = [];
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
      blocks.push(...page.results);
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return blocks;
  }

  /**
   * Whether the page already shows this payload. A page written before the key
   * moved into the database still carries its marker line, so that counts too
   * and the section is not appended a second time.
   */
  private async sectionApplied(
    epicId: string,
    section: "plan" | "page",
    pageId: string,
    payloadHash: string,
  ): Promise<boolean> {
    const row = (await this.client.execute({
      sql: "SELECT payload_hash FROM epic_notion_sections WHERE epic_id = ? AND section = ?",
      args: [epicId, section],
    })).rows[0];
    if (row && String(row.payload_hash) === payloadHash) return true;
    const legacy = new Set(LEGACY_MARKER_PREFIXES.map((prefix) => `${prefix}${payloadHash}`));
    const present = (await this.children(pageId))
      .some((block) => legacy.has(plainText(block.paragraph)));
    if (present) await this.rememberSection(epicId, section, payloadHash);
    return present;
  }

  private async rememberSection(epicId: string, section: "plan" | "page", payloadHash: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO epic_notion_sections (epic_id, section, payload_hash, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(epic_id, section) DO UPDATE SET
              payload_hash = excluded.payload_hash, updated_at = excluded.updated_at`,
      args: [epicId, section, payloadHash, this.now()],
    });
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
      heading(epicSectionTitle("plan")),
      // The name reads as the name; the id follows it as a handle, in code
      // style, which is also how a person quotes it back in a comment.
      ...plan.stories.map((story) => richBullet(runs(t(story.title), t(" "), code(story.id)))),
      ...(plan.recommendation ? [paragraph(plan.recommendation)] : []),
    ];
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encoded(record.target)}/children`,
      priority: "interaction",
      body: { children },
    });
    // The outbox may hand the same plan back after a crash, and an appended
    // plan cannot be diffed the way a property can.
    await this.rememberSection(plan.epicId, "plan", record.payloadHash);
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
      [names.title]: { title: [text(String(story.title))] },
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
        // The callout is created with the page: a block can only be appended
        // after another one, so the only way it sits at the top is to be there
        // from the start.
        children: [
          calloutBlock(quietText()),
          heading(sectionTitle("requirement")),
          paragraph(String(story.requirement)),
        ],
      },
    });
    const pageId = z.object({ id: z.string().min(1) }).parse(created.data).id;
    await this.rememberPageId(payload.storyId, pageId);
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
