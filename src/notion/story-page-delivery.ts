import type { Client, InStatement } from "@libsql/client";
import { z } from "zod";
import type { NotionGateway } from "./gateway.js";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "./outbox.js";
import {
  planStoryPageUpdate,
  type DesiredStoryPage,
  type StoryPageOperation,
  type StoryPageSnapshot,
  type StorySection,
} from "./blocks/story-page.js";

const SECTION_TITLES: Record<StorySection, string> = {
  requirement: "\u9700\u6c42\u63cf\u8ff0",
  specification: "\u9700\u6c42\u89c4\u683c",
  design: "\u6838\u5fc3\u8bbe\u8ba1",
  verification: "\u9a8c\u8bc1\u8bb0\u5f55",
  questions: "\u5f85\u4eba\u56de\u7b54",
};
const TITLE_SECTIONS = new Map(Object.entries(SECTION_TITLES).map(([section, title]) => [title, section as StorySection]));
const HISTORY_TITLE = "\u5386\u53f2\u9a8c\u8bc1\u8bb0\u5f55";
const richTextItemSchema = z.object({ plain_text: z.string() }).passthrough();
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
const desiredSpecSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().positive(),
  status: z.string().min(1),
  text: z.string(),
});
const payloadSchema = z.object({
  cardId: z.string().min(1),
  pageId: z.string().min(1),
  desired: z.object({
    metadata: z.string(),
    design: z.string(),
    questions: z.string().optional(),
    specs: z.array(desiredSpecSchema),
    verificationRound: z.object({ round: z.number().int().positive(), summary: z.string() }).optional(),
  }),
});

type NotionBlock = z.infer<typeof blockSchema>;

interface RemoteStoryPage {
  snapshot: StoryPageSnapshot;
  blockTypes: Map<string, string>;
  historyPageId?: string;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function textOf(item: NotionBlock): string {
  const value = item[item.type];
  const parsed = z.object({ rich_text: z.array(richTextItemSchema) }).passthrough().safeParse(value);
  return parsed.success ? parsed.data.rich_text.map((richItem) => richItem.plain_text).join("") : "";
}

function childPageTitle(item: NotionBlock): string {
  const parsed = z.object({ title: z.string() }).passthrough().safeParse(item.child_page);
  return parsed.success ? parsed.data.title : "";
}

function richText(content: string): Array<{ type: "text"; text: { content: string } }> {
  if (content.length > 2_000) throw new Error("Notion block content exceeds the 2000 character limit");
  return [{ type: "text", text: { content } }];
}

function notionBlock(type: "paragraph" | "callout" | "heading_2" | "toggle", content: string): Record<string, unknown> {
  return {
    object: "block",
    type,
    [type]: {
      rich_text: richText(content),
      ...(type === "callout" ? { icon: { type: "emoji", emoji: "\u2139\ufe0f" } } : {}),
    },
  };
}

function parseSpec(content: string): { id: string; status: string; text: string } | undefined {
  const match = /^(\S+) \[([^\]]+)](?: (.*))?$/.exec(content);
  return match ? { id: match[1]!, status: match[2]!, text: match[3] ?? "" } : undefined;
}

function parseRound(content: string): { round: number; summary: string } | undefined {
  const match = /^Round (\d+):(?: (.*))?$/.exec(content);
  return match ? { round: Number(match[1]), summary: match[2] ?? "" } : undefined;
}

/** Replays desired Story page projections through the orchestrator's sole Notion gateway. */
export class NotionStoryPageDelivery implements NotionOutboxDelivery {
  constructor(
    private readonly client: Client,
    private readonly gateway: NotionGateway,
    private readonly now: () => number = Date.now,
  ) {}

  async isApplied(record: NotionOutboxRecord): Promise<boolean> {
    const payload = this.payload(record);
    const remote = await this.readPage(payload.cardId, payload.pageId);
    return planStoryPageUpdate(remote.snapshot, this.desired(payload.desired)).length === 0;
  }

  async send(record: NotionOutboxRecord): Promise<void> {
    const payload = this.payload(record);
    const desired = this.desired(payload.desired);
    for (let pass = 0; pass < 8; pass++) {
      const remote = await this.readPage(payload.cardId, payload.pageId);
      const operations = planStoryPageUpdate(remote.snapshot, desired);
      if (operations.length === 0) return;
      await this.applyOperations(payload.cardId, payload.pageId, desired, remote, operations);
    }
    throw new Error(`Notion Story page did not converge: ${payload.pageId}`);
  }

  private payload(record: NotionOutboxRecord): z.infer<typeof payloadSchema> {
    if (record.operation !== "sync_story_page") {
      throw new Error(`unsupported Notion outbox operation: ${record.operation}`);
    }
    return payloadSchema.parse(record.payload);
  }

  private desired(input: z.infer<typeof payloadSchema>["desired"]): DesiredStoryPage {
    return {
      metadata: input.metadata,
      design: input.design,
      specs: input.specs,
      ...(input.questions === undefined ? {} : { questions: input.questions }),
      ...(input.verificationRound === undefined ? {} : { verificationRound: input.verificationRound }),
    };
  }

  private async listChildren(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const suffix = cursor ? `?start_cursor=${encoded(cursor)}&page_size=100` : "?page_size=100";
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/blocks/${encoded(blockId)}/children${suffix}`,
        priority: "projection",
      });
      const parsed = listSchema.parse(response.data);
      blocks.push(...parsed.results.filter((item) => !item.archived));
      cursor = parsed.has_more && parsed.next_cursor ? parsed.next_cursor : undefined;
    } while (cursor);
    return blocks;
  }

  private async readPage(cardId: string, pageId: string): Promise<RemoteStoryPage> {
    const blocks = await this.listChildren(pageId);
    const blockTypes = new Map(blocks.map((item) => [item.id, item.type]));
    const snapshot: StoryPageSnapshot = { sections: {}, specs: [], verificationRounds: [] };
    let active: StorySection | undefined;
    let historyPageId: string | undefined;

    for (const item of blocks) {
      const content = textOf(item);
      if (item.type === "child_page" && childPageTitle(item) === HISTORY_TITLE) historyPageId = item.id;
      if (item.type === "callout" && !snapshot.metadata) {
        snapshot.metadata = { blockId: item.id, content };
        continue;
      }
      if (item.type === "heading_2") {
        active = TITLE_SECTIONS.get(content);
        if (active) snapshot.sections[active] = { anchorBlockId: item.id };
        continue;
      }
      if (!active) continue;
      if ((active === "design" || active === "questions") && item.type === "paragraph") {
        const section = snapshot.sections[active];
        if (section && !section.contentBlockId) {
          section.contentBlockId = item.id;
          section.content = content;
        }
      } else if (active === "specification" && item.type === "paragraph") {
        const parsed = parseSpec(content);
        if (parsed) snapshot.specs.push({ ...parsed, seq: snapshot.specs.length + 1, blockId: item.id });
      } else if (active === "verification" && item.type === "toggle") {
        const parsed = parseRound(content);
        if (parsed) snapshot.verificationRounds.push({ ...parsed, toggleBlockId: item.id });
      }
    }
    await this.rememberSnapshot(cardId, snapshot);
    return { snapshot, blockTypes, ...(historyPageId ? { historyPageId } : {}) };
  }

  private async rememberSnapshot(cardId: string, snapshot: StoryPageSnapshot): Promise<void> {
    const statements: InStatement[] = [];
    for (const [section, value] of Object.entries(snapshot.sections)) {
      if (!value) continue;
      statements.push({
        sql: `INSERT INTO notion_sections (story_id, section, anchor_block_id, content_block_id)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(story_id, section) DO UPDATE SET
                anchor_block_id = excluded.anchor_block_id,
                content_block_id = excluded.content_block_id`,
        args: [cardId, section, value.anchorBlockId, value.contentBlockId ?? null],
      });
    }
    if (snapshot.metadata) {
      statements.push({
        sql: `INSERT INTO notion_sections (story_id, section, anchor_block_id)
              VALUES (?, 'metadata', ?)
              ON CONFLICT(story_id, section) DO UPDATE SET anchor_block_id = excluded.anchor_block_id`,
        args: [cardId, snapshot.metadata.blockId],
      });
    }
    for (const spec of snapshot.specs) {
      statements.push({
        sql: "UPDATE story_specs SET notion_block_id = ? WHERE story_id = ? AND spec_id = ?",
        args: [spec.blockId, cardId, spec.id],
      });
    }
    for (const round of snapshot.verificationRounds) {
      statements.push({
        sql: `INSERT INTO notion_verification_rounds
                (story_id, round, toggle_block_id, summary, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(story_id, round) DO UPDATE SET
                toggle_block_id = excluded.toggle_block_id,
                summary = excluded.summary`,
        args: [cardId, round.round, round.toggleBlockId, round.summary, this.now()],
      });
    }
    if (statements.length > 0) await this.client.batch(statements, "write");
  }

  private async append(parentId: string, children: Record<string, unknown>[], after?: string): Promise<NotionBlock[]> {
    const response = await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encoded(parentId)}/children`,
      priority: "projection",
      body: { children, ...(after ? { after } : {}) },
    });
    return listSchema.parse(response.data).results;
  }

  private async update(blockId: string, type: string, content: string): Promise<void> {
    if (type !== "callout" && type !== "paragraph" && type !== "toggle") {
      throw new Error(`cannot update unsupported Notion block type: ${type}`);
    }
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encoded(blockId)}`,
      priority: "projection",
      body: { [type]: { rich_text: richText(content) } },
    });
  }

  private async applyOperations(
    cardId: string,
    pageId: string,
    desired: DesiredStoryPage,
    remote: RemoteStoryPage,
    operations: StoryPageOperation[],
  ): Promise<void> {
    for (const operation of operations) {
      if (operation.type === "create_section") {
        await this.append(pageId, [notionBlock("heading_2", SECTION_TITLES[operation.section])]);
      } else if (operation.type === "insert_metadata") {
        await this.append(pageId, [notionBlock("callout", operation.content)]);
      } else if (operation.type === "insert_content") {
        await this.append(pageId, [notionBlock("paragraph", operation.content)], operation.afterBlockId);
      } else if (operation.type === "update_block") {
        const type = remote.blockTypes.get(operation.blockId);
        if (!type) throw new Error(`Notion block disappeared before update: ${operation.blockId}`);
        await this.update(operation.blockId, type, operation.content);
      } else if (operation.type === "insert_spec") {
        await this.insertSpec(cardId, pageId, desired, remote.snapshot, operation);
      } else if (operation.type === "insert_verification_round") {
        const [created] = await this.append(pageId, [
          notionBlock("toggle", `Round ${operation.round}: ${operation.summary}`),
        ], operation.afterBlockId);
        if (!created) throw new Error("Notion did not return the inserted verification block");
        await this.client.execute({
          sql: `INSERT INTO notion_verification_rounds
                  (story_id, round, toggle_block_id, summary, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(story_id, round) DO UPDATE SET
                  toggle_block_id = excluded.toggle_block_id, summary = excluded.summary`,
          args: [cardId, operation.round, created.id, operation.summary, this.now()],
        });
      } else if (operation.type === "archive_verification_rounds") {
        await this.archiveRounds(cardId, pageId, remote, operation.rounds);
      } else {
        await this.gateway.request({
          method: "PATCH",
          path: `/v1/blocks/${encoded(operation.blockId)}`,
          priority: "projection",
          body: { archived: true },
        });
      }
    }
  }

  private async insertSpec(
    cardId: string,
    pageId: string,
    desired: DesiredStoryPage,
    snapshot: StoryPageSnapshot,
    operation: Extract<StoryPageOperation, { type: "insert_spec" }>,
  ): Promise<void> {
    const preceding = desired.specs
      .filter((candidate) => candidate.seq < operation.seq)
      .toSorted((left, right) => right.seq - left.seq)
      .find((candidate) => snapshot.specs.some((current) => current.id === candidate.id));
    const afterBlockId = preceding
      ? snapshot.specs.find((current) => current.id === preceding.id)!.blockId
      : operation.afterBlockId;
    const [created] = await this.append(pageId, [notionBlock("paragraph", operation.content)], afterBlockId);
    if (!created) throw new Error("Notion did not return the inserted Spec block");
    await this.client.execute({
      sql: "UPDATE story_specs SET notion_block_id = ? WHERE story_id = ? AND spec_id = ?",
      args: [created.id, cardId, operation.specId],
    });
  }

  private async archiveRounds(
    cardId: string,
    pageId: string,
    remote: RemoteStoryPage,
    rounds: Array<{ round: number; toggleBlockId: string }>,
  ): Promise<void> {
    let historyPageId = remote.historyPageId;
    if (!historyPageId) {
      const response = await this.append(pageId, [{ object: "block", type: "child_page", child_page: { title: HISTORY_TITLE } }]);
      historyPageId = response[0]?.id;
      if (!historyPageId) throw new Error("Notion did not return the verification history page");
    }
    const existing = new Set((await this.listChildren(historyPageId)).map(textOf));
    for (const item of rounds) {
      const summary = remote.snapshot.verificationRounds.find((round) => round.round === item.round)?.summary ?? "";
      const content = `Round ${item.round}: ${summary}`;
      if (!existing.has(content)) await this.append(historyPageId, [notionBlock("paragraph", content)]);
      await this.gateway.request({
        method: "PATCH",
        path: `/v1/blocks/${encoded(item.toggleBlockId)}`,
        priority: "projection",
        body: { archived: true },
      });
      await this.client.execute({
        sql: `UPDATE notion_verification_rounds SET archived_page_id = ?
              WHERE story_id = ? AND round = ?`,
        args: [historyPageId, cardId, item.round],
      });
    }
  }
}
