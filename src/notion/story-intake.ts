import type { Client } from "@notionhq/client";
import { z } from "zod";
import type { StoryExecutionStore, StoryIntake } from "../orchestrator/story-execution-store.js";
import type { StorySection } from "./blocks/story-page.js";
import type { NotionGateway } from "./gateway.js";
import schema from "./notion-schema.json" with { type: "json" };

const richTextItem = z.object({ plain_text: z.string() }).passthrough();
const titleProperty = z.object({ type: z.literal("title"), title: z.array(richTextItem) }).passthrough();
const richTextProperty = z.object({ type: z.literal("rich_text"), rich_text: z.array(richTextItem) }).passthrough();
const selectProperty = z.object({
  type: z.literal("select"),
  select: z.object({ name: z.string() }).nullable(),
}).passthrough();
const multiSelectProperty = z.object({
  type: z.literal("multi_select"),
  multi_select: z.array(z.object({ name: z.string() }).passthrough()),
}).passthrough();
const pageSchema = z.object({
  object: z.literal("page"),
  id: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
}).passthrough();
const blockSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
}).passthrough();

const SECTION_NAMES: Record<string, StorySection> = {
  "需求描述": "requirement",
  "需求规格": "specification",
  "核心设计": "design",
  "验证记录": "verification",
  "待人回答": "questions",
};

export interface NotionStoryApi {
  queryReady(dataSourceId: string, cursor?: string): Promise<{
    results: unknown[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;
  listChildren(blockId: string, cursor?: string): Promise<{
    results: unknown[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;
}

export class NotionSdkStoryApi implements NotionStoryApi {
  constructor(private readonly client: Pick<Client, "dataSources" | "blocks">) {}

  async queryReady(dataSourceId: string, cursor?: string) {
    const response = await this.client.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        property: schema.propertyNames.aiStatus,
        select: { equals: schema.options.aiStatus[0]! },
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    return {
      results: response.results,
      hasMore: response.has_more,
      nextCursor: response.next_cursor,
    };
  }

  async listChildren(blockId: string, cursor?: string) {
    const response = await this.client.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    return {
      results: response.results,
      hasMore: response.has_more,
      nextCursor: response.next_cursor,
    };
  }
}

const listResponseSchema = z.object({
  results: z.array(z.unknown()),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
}).passthrough();

/** Runs Story intake reads through the central gateway and its shared rate budget. */
export class NotionGatewayStoryApi implements NotionStoryApi {
  constructor(private readonly gateway: NotionGateway) {}

  async queryReady(dataSourceId: string, cursor?: string) {
    const response = await this.gateway.request({
      method: "POST",
      path: `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      priority: "interaction",
      body: {
        filter: {
          property: schema.propertyNames.aiStatus,
          select: { equals: schema.options.aiStatus[0]! },
        },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    });
    const parsed = listResponseSchema.parse(response.data);
    return { results: parsed.results, hasMore: parsed.has_more, nextCursor: parsed.next_cursor };
  }

  async listChildren(blockId: string, cursor?: string) {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const response = await this.gateway.request({
      method: "GET",
      path: `/v1/blocks/${encodeURIComponent(blockId)}/children?${query.toString()}`,
      priority: "interaction",
    });
    const parsed = listResponseSchema.parse(response.data);
    return { results: parsed.results, hasMore: parsed.has_more, nextCursor: parsed.next_cursor };
  }
}

export interface ReadyStory extends StoryIntake {
  sections: Partial<Record<StorySection, string>>;
}

export class IncompleteNotionStoryError extends Error {
  constructor(pageId: string, reason: string) {
    super(`Notion Story ${pageId} is incomplete: ${reason}`);
    this.name = "IncompleteNotionStoryError";
  }
}

function plainText(items: z.infer<typeof richTextItem>[]): string {
  return items.map((item) => item.plain_text).join("").trim();
}

function title(properties: Record<string, unknown>, pageId: string): string {
  const parsed = titleProperty.safeParse(properties[schema.propertyNames.title]);
  const value = parsed.success ? plainText(parsed.data.title) : "";
  if (!value) throw new IncompleteNotionStoryError(pageId, "title is empty");
  return value;
}

function richText(properties: Record<string, unknown>, name: string): string {
  const parsed = richTextProperty.safeParse(properties[name]);
  return parsed.success ? plainText(parsed.data.rich_text) : "";
}

function select(properties: Record<string, unknown>, name: string): string {
  const parsed = selectProperty.safeParse(properties[name]);
  return parsed.success ? parsed.data.select?.name ?? "" : "";
}

function multiSelect(properties: Record<string, unknown>, name: string): string[] {
  const parsed = multiSelectProperty.safeParse(properties[name]);
  return parsed.success ? parsed.data.multi_select.map((item) => item.name).toSorted() : [];
}

function blockText(block: z.infer<typeof blockSchema>): string {
  const payload = block[block.type];
  if (typeof payload !== "object" || payload === null) return "";
  const parsed = z.object({ rich_text: z.array(richTextItem) }).passthrough().safeParse(payload);
  return parsed.success ? plainText(parsed.data.rich_text) : "";
}

async function allChildren(api: NotionStoryApi, pageId: string): Promise<Array<z.infer<typeof blockSchema>>> {
  const blocks: Array<z.infer<typeof blockSchema>> = [];
  let cursor: string | undefined;
  do {
    const response = await api.listChildren(pageId, cursor);
    for (const value of response.results) {
      const parsed = blockSchema.safeParse(value);
      if (parsed.success) blocks.push(parsed.data);
    }
    cursor = response.hasMore && response.nextCursor ? response.nextCursor : undefined;
  } while (cursor);
  return blocks;
}

export async function readStoryContent(api: NotionStoryApi, pageId: string): Promise<{
  requirement: string;
  sections: Partial<Record<StorySection, string>>;
}> {
  const blocks = await allChildren(api, pageId);
  const sections: Partial<Record<StorySection, string>> = {};
  const requirement: string[] = [];
  let active: StorySection | undefined;
  for (const block of blocks) {
    if (block.type === "heading_2") {
      active = SECTION_NAMES[blockText(block)];
      if (active) sections[active] = block.id;
      continue;
    }
    if (active === "requirement") {
      const text = blockText(block);
      if (text) requirement.push(text);
    }
  }
  const body = requirement.join("\n").trim();
  if (!sections.requirement) throw new IncompleteNotionStoryError(pageId, "requirement heading is missing");
  if (!body) throw new IncompleteNotionStoryError(pageId, "requirement is empty");
  return { requirement: body, sections };
}

function priority(value: string): number {
  const match = /^P([0-3])$/.exec(value);
  return match ? Number(match[1]) : 2;
}

/** Reads every ready card and turns human-owned Notion fields into central intake rows. */
export async function listReadyStories(api: NotionStoryApi, dataSourceId: string): Promise<ReadyStory[]> {
  const stories: ReadyStory[] = [];
  let cursor: string | undefined;
  do {
    const response = await api.queryReady(dataSourceId, cursor);
    for (const value of response.results) {
      const page = pageSchema.safeParse(value);
      if (!page.success) continue;
      const names = schema.propertyNames;
      const taskId = richText(page.data.properties, names.taskId);
      if (!taskId) throw new IncompleteNotionStoryError(page.data.id, "task id is empty");
      const repository = select(page.data.properties, names.repository);
      if (!repository) throw new IncompleteNotionStoryError(page.data.id, "target repository is empty");
      const content = await readStoryContent(api, page.data.id);
      stories.push({
        id: taskId,
        notionPageId: page.data.id,
        title: title(page.data.properties, page.data.id),
        requirement: content.requirement,
        repo: repository,
        branch: `story/${taskId.toLowerCase()}`,
        targetBranch: richText(page.data.properties, names.targetBranch) || "main",
        priority: priority(select(page.data.properties, names.priority)),
        capabilities: multiSelect(page.data.properties, names.capabilities),
        sections: content.sections,
      });
    }
    cursor = response.hasMore && response.nextCursor ? response.nextCursor : undefined;
  } while (cursor);
  return stories.toSorted((left, right) => left.id.localeCompare(right.id, "en"));
}

export async function ingestReadyStories(
  api: NotionStoryApi,
  dataSourceId: string,
  store: StoryExecutionStore,
): Promise<string[]> {
  const created: string[] = [];
  for (const story of await listReadyStories(api, dataSourceId)) {
    const inserted = await store.createStory(story);
    for (const [section, anchorBlockId] of Object.entries(story.sections)) {
      await store.registerNotionSection(story.id, section as StorySection, anchorBlockId);
    }
    if (inserted) created.push(story.id);
  }
  return created;
}
