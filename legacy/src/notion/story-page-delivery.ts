import type { Client, InStatement } from "@libsql/client";
import { z } from "zod";
import { archiveBlock, NotionGatewayError, type NotionGateway } from "./gateway.js";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "./outbox.js";
import { quietText, sectionForTitle, sectionTitle } from "./display-text.js";
import {
  foldedBlocks,
  roundBlocks,
  roundTitle,
  specDetailBlocks,
  specRuns,
} from "./blocks/story-render.js";
import { callout, heading2, mermaid, paragraph, t, toggle, type Block, type RichTextRun } from "./rich-text.js";
import { payloadHash } from "./outbox.js";
import {
  planStoryPageUpdate,
  type DesiredStoryPage,
  type StoryPageOperation,
  type StoryPageSnapshot,
  type StorySection,
} from "./blocks/story-page.js";

const HISTORY_TITLE = "\u5386\u53f2\u9a8c\u8bc1\u8bb0\u5f55";
/** The toggle a section folds its own content behind. Its words never change,
 * so the planner never rewrites the line; what it holds is compared by hash. */
const TECHNICAL_TITLE = "\u5c55\u5f00\u6280\u672f\u7ec6\u8282";
const ANSWERS_TITLE = "\u56de\u7b54\u8bb0\u5f55";
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
  title: z.string().min(1),
  given: z.string().optional(),
  when: z.string().optional(),
  // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external DoD contract.
  then: z.string().optional(),
  layers: z.array(z.string()).optional(),
});
const desiredRoundSchema = z.object({
  round: z.number().int().positive(),
  at: z.number().int().nonnegative(),
  verdict: z.string().min(1),
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  rows: z.array(z.object({
    scenario: z.string(),
    test: z.string(),
    screen: z.string(),
    note: z.string(),
  })),
  findings: z.array(z.string()).optional(),
});
const payloadSchema = z.object({
  cardId: z.string().min(1),
  pageId: z.string().min(1),
  desired: z.object({
    metadata: z.string().optional(),
    metadataIcon: z.string().optional(),
    metadataColor: z.string().optional(),
    design: z.string(),
    diagram: z.string().optional(),
    questions: z.string().optional(),
    answers: z.array(z.string()).optional(),
    technical: z.array(z.string()).optional(),
    specs: z.array(desiredSpecSchema),
    verificationRound: desiredRoundSchema.optional(),
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

/** The scenario a line belongs to, whichever version of the page wrote it:
 * the id is the one thing every version has carried. */
function parseSpec(content: string): { id: string } | undefined {
  const match = /S-[A-Za-z0-9]+-\d{2}-[a-z0-9]+/.exec(content);
  return match ? { id: match[0] } : undefined;
}

/** A round toggle, read back from either the line this version writes
 * ("\u7b2c 3 \u8f6e \u00b7 ...") or the one an older page left behind ("Round 3: ..."). */
function parseRound(content: string): { round: number; summary: string } | undefined {
  // No word boundary after the character: it is not an ASCII word character,
  // so \b would never match there.
  const current = /^\u7b2c (\d+) \u8f6e/.exec(content);
  if (current) return { round: Number(current[1]), summary: content };
  const legacy = /^Round (\d+):(?: ([\s\S]*))?$/.exec(content);
  return legacy ? { round: Number(legacy[1]), summary: content } : undefined;
}

/** Identifies an insert so a repeated plan for the same content is recognised;
 * edits and archives carry their block id and never collide. */
function insertKey(operation: StoryPageOperation): string {
  switch (operation.type) {
    case "insert_content": return `content:${operation.section}`;
    case "insert_verification_round": return `round:${operation.round.round}`;
    case "insert_spec": return `spec:${operation.specId}`;
    case "insert_metadata": return "metadata";
    case "create_section": return `section:${operation.section}`;
    default: return `${operation.type}:${JSON.stringify(operation)}`;
  }
}

/** Replays desired Story page projections through the orchestrator's sole Notion gateway. */
export class NotionStoryPageDelivery implements NotionOutboxDelivery {
  constructor(
    private readonly client: Client,
    private readonly gateway: NotionGateway,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether a block we recorded is still on its page. A block a person deleted
   * answers 404, and one Notion archived reads back archived; both mean the
   * page no longer holds it and the round must be written again.
   */
  private async blockExists(blockId: string): Promise<boolean> {
    try {
      const response = await this.gateway.request({
        method: "GET",
        path: `/v1/blocks/${encodeURIComponent(blockId)}`,
        priority: "projection",
      });
      const block = response.data as { archived?: boolean; in_trash?: boolean };
      return block.archived !== true && block.in_trash !== true;
    } catch (error) {
      if (error instanceof NotionGatewayError && error.status === 404) return false;
      if (/could not be found/i.test((error as Error).message)) return false;
      throw error;
    }
  }

  async isApplied(record: NotionOutboxRecord): Promise<boolean> {
    const payload = this.payload(record);
    const remote = await this.readPage(payload.cardId, payload.pageId);
    return planStoryPageUpdate(remote.snapshot, this.desired(payload.desired)).length === 0;
  }

  async send(record: NotionOutboxRecord): Promise<void> {
    const payload = this.payload(record);
    const desired = this.desired(payload.desired);
    // Notion's children listing can lag a just-completed append. An insert
    // planned again for something this send already inserted is that lag, not
    // missing content; inserting again would leave a duplicate on the page.
    const inserted = new Set<string>();
    for (let pass = 0; pass < 8; pass++) {
      const remote = await this.readPage(payload.cardId, payload.pageId);
      const operations = planStoryPageUpdate(remote.snapshot, desired)
        .filter((operation) => !inserted.has(insertKey(operation)));
      // Children hang off blocks that may have been created in the pass
      // before, so they are written from a fresh read rather than from the
      // append that made them.
      const wroteChildren = await this.syncChildren(payload, remote);
      if (operations.length === 0 && !wroteChildren) return;
      if (operations.length > 0) {
        await this.applyOperations(payload, desired, remote, operations);
        for (const operation of operations) inserted.add(insertKey(operation));
      }
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
      design: input.design,
      specs: input.specs,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.questions === undefined ? {} : { questions: input.questions }),
      ...(input.technical && input.technical.length > 0 ? { technical: TECHNICAL_TITLE } : {}),
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
        // Both the name this version writes and the one an older page wrote:
        // a heading nobody recognises is a section anchor lost, and with it
        // every comment hanging off the blocks beneath it.
        active = sectionForTitle(content);
        if (active) snapshot.sections[active] = { anchorBlockId: item.id, title: content };
        continue;
      }
      if (!active) continue;
      const holds = (active === "design" || active === "questions") && item.type === "paragraph"
        || active === "technical" && item.type === "toggle";
      if (holds) {
        const section = snapshot.sections[active];
        if (section && !section.contentBlockId) {
          section.contentBlockId = item.id;
          section.content = content;
        }
      } else if (active === "specification" && item.type === "paragraph") {
        const parsed = parseSpec(content);
        if (parsed) {
          snapshot.specs.push({ id: parsed.id, line: content, seq: snapshot.specs.length + 1, blockId: item.id });
        }
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

  private async update(
    blockId: string,
    type: string,
    content: RichTextRun[],
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (type !== "callout" && type !== "paragraph" && type !== "toggle") {
      throw new Error(`cannot update unsupported Notion block type: ${type}`);
    }
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encoded(blockId)}`,
      priority: "projection",
      body: { [type]: { rich_text: content, ...extra } },
    });
  }

  /** The callout is the only block that says it is a person's turn, so it
   * carries the icon and colour that say which kind of turn it is. */
  private metadataBlock(input: z.infer<typeof payloadSchema>["desired"], content: string): Block {
    const quiet = quietText();
    return callout(t(content), input.metadataIcon ?? quiet.icon, input.metadataColor ?? quiet.color);
  }

  private async applyOperations(
    payload: z.infer<typeof payloadSchema>,
    desired: DesiredStoryPage,
    remote: RemoteStoryPage,
    operations: StoryPageOperation[],
  ): Promise<void> {
    const { cardId, pageId } = payload;
    for (const operation of operations) {
      if (operation.type === "create_section") {
        await this.append(pageId, [heading2(t(sectionTitle(operation.section)))]);
      } else if (operation.type === "rename_section") {
        // The heading keeps its block: every scenario paragraph under it, and
        // every comment a person left on those, hangs off this anchor.
        await this.gateway.request({
          method: "PATCH",
          path: `/v1/blocks/${encoded(operation.blockId)}`,
          priority: "projection",
          body: { heading_2: { rich_text: t(sectionTitle(operation.section)) } },
        });
      } else if (operation.type === "insert_metadata") {
        await this.append(pageId, [this.metadataBlock(payload.desired, operation.content)]);
      } else if (operation.type === "insert_content") {
        await this.append(pageId, [
          operation.section === "technical"
            ? toggle(t(operation.content))
            : paragraph(t(operation.content)),
        ], operation.afterBlockId);
      } else if (operation.type === "update_block") {
        const type = remote.blockTypes.get(operation.blockId);
        if (!type) throw new Error(`Notion block disappeared before update: ${operation.blockId}`);
        const spec = desired.specs.find((candidate) => remote.snapshot.specs
          .some((current) => current.id === candidate.id && current.blockId === operation.blockId));
        const content = spec ? specRuns(spec) : t(operation.content);
        const quiet = quietText();
        const extra = type === "callout"
          ? {
              icon: { type: "emoji", emoji: payload.desired.metadataIcon ?? quiet.icon },
              color: payload.desired.metadataColor ?? quiet.color,
            }
          : {};
        await this.update(operation.blockId, type, content, extra);
      } else if (operation.type === "insert_spec") {
        await this.insertSpec(cardId, pageId, desired, remote.snapshot, operation);
      } else if (operation.type === "insert_verification_round") {
        // A round this process inserted moments ago may not be listed on the
        // page yet, and appending is not idempotent, so the recorded toggle is
        // asked about directly. The page, not the outbox row, is what must
        // hold exactly one toggle per round.
        const known = (await this.client.execute({
          sql: `SELECT toggle_block_id FROM notion_verification_rounds
                WHERE story_id = ? AND round = ? AND archived_page_id IS NULL`,
          args: [cardId, operation.round.round],
        })).rows[0];
        if (known && await this.blockExists(String(known.toggle_block_id))) continue;
        const title = roundTitle(operation.round);
        const [created] = await this.append(pageId, [toggle(t(title))], operation.afterBlockId);
        if (!created) throw new Error("Notion did not return the inserted verification block");
        // The table goes in as a second call: one append nests two levels, and
        // a table inside a toggle is three.
        await this.append(created.id, roundBlocks(operation.round));
        await this.client.execute({
          sql: `INSERT INTO notion_verification_rounds
                  (story_id, round, toggle_block_id, summary, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(story_id, round) DO UPDATE SET
                  toggle_block_id = excluded.toggle_block_id, summary = excluded.summary`,
          args: [cardId, operation.round.round, created.id, title, this.now()],
        });
      } else if (operation.type === "archive_verification_rounds") {
        await this.archiveRounds(cardId, pageId, remote, operation.rounds);
      } else {
        await archiveBlock((input) => this.gateway.request(input), operation.blockId);
      }
    }
  }

  /**
   * The blocks that hang under a block a person already sees: the four lines
   * of a scenario, the diagram under the design, the answers a person gave,
   * the technical notes. They are rewritten only when the hash of what they
   * should say moved, because rebuilding them costs a request per block and
   * loses nothing a person wrote (nobody comments on a folded bullet).
   */
  private async syncChildren(
    payload: z.infer<typeof payloadSchema>,
    remote: RemoteStoryPage,
  ): Promise<boolean> {
    const { cardId } = payload;
    const input = payload.desired;
    let wrote = false;

    for (const spec of input.specs) {
      const current = remote.snapshot.specs.find((candidate) => candidate.id === spec.id);
      if (!current) continue;
      const blocks = specDetailBlocks(spec);
      const changed = await this.rebuildChildren(current.blockId, blocks, {
        sql: "SELECT notion_detail_hash AS hash FROM story_specs WHERE story_id = ? AND spec_id = ?",
        args: [cardId, spec.id],
      }, (hash) => ({
        sql: "UPDATE story_specs SET notion_detail_hash = ? WHERE story_id = ? AND spec_id = ?",
        args: [hash, cardId, spec.id],
      }));
      wrote ||= changed;
    }

    const sections: Array<[StorySection, Block[]]> = [
      ["design", input.diagram ? [mermaid(input.diagram)] : []],
      ["questions", input.answers && input.answers.length > 0 ? foldedBlocks(ANSWERS_TITLE, input.answers) : []],
      ["technical", (input.technical ?? []).map((line) => paragraph(t(line)))],
    ];
    for (const [section, blocks] of sections) {
      const holder = remote.snapshot.sections[section]?.contentBlockId;
      if (!holder) continue;
      const changed = await this.rebuildChildren(holder, blocks, {
        sql: "SELECT content_hash AS hash FROM notion_sections WHERE story_id = ? AND section = ?",
        args: [cardId, section],
      }, (hash) => ({
        sql: "UPDATE notion_sections SET content_hash = ? WHERE story_id = ? AND section = ?",
        args: [hash, cardId, section],
      }));
      wrote ||= changed;
    }
    return wrote;
  }

  private async rebuildChildren(
    parentId: string,
    blocks: Block[],
    read: InStatement,
    write: (hash: string) => InStatement,
  ): Promise<boolean> {
    const hash = payloadHash({ parentId, blocks }).hash;
    const current = (await this.client.execute(read)).rows[0]?.hash;
    if (current !== null && current !== undefined && String(current) === hash) return false;
    for (const child of await this.listChildren(parentId)) {
      await archiveBlock((request) => this.gateway.request(request), child.id);
    }
    if (blocks.length > 0) await this.append(parentId, blocks);
    // Nowhere to remember it means nowhere to compare it next time, and a send
    // that keeps reporting work would never finish its passes.
    return (await this.client.execute(write(hash))).rowsAffected > 0;
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
    const spec = desired.specs.find((candidate) => candidate.id === operation.specId);
    const [created] = await this.append(
      pageId,
      [paragraph(spec ? specRuns(spec) : t(operation.content))],
      afterBlockId,
    );
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
      // A child page is created as a page with this page as its parent; the
      // API refuses a `child_page` block appended through children (400), and
      // every retry of that refusal kept the whole Story page from updating.
      const response = await this.gateway.request({
        method: "POST",
        path: "/v1/pages",
        priority: "projection",
        body: {
          parent: { page_id: pageId },
          properties: { title: { title: [{ type: "text", text: { content: HISTORY_TITLE } }] } },
        },
      });
      const created = z.object({ id: z.string().min(1) }).passthrough().safeParse(response.data);
      if (!created.success) throw new Error("Notion did not return the verification history page");
      historyPageId = created.data.id;
    }
    const existing = new Set((await this.listChildren(historyPageId)).map(textOf));
    for (const item of rounds) {
      const summary = remote.snapshot.verificationRounds.find((round) => round.round === item.round)?.summary ?? "";
      const content = `Round ${item.round}: ${summary}`;
      if (!existing.has(content)) await this.append(historyPageId, [paragraph(t(content))]);
      await archiveBlock((input) => this.gateway.request(input), item.toggleBlockId);
      await this.client.execute({
        sql: `UPDATE notion_verification_rounds SET archived_page_id = ?
              WHERE story_id = ? AND round = ?`,
        args: [historyPageId, cardId, item.round],
      });
    }
  }
}
