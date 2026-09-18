import type { Client } from "@libsql/client";
import { z } from "zod";
import {
  REQUIREMENT_SECTION_ORDER,
  planRequirementPageUpdate,
  prdFrozenLine,
  solutionBlocks,
  type DesiredClarifyRound,
  type DesiredPrd,
  type DesiredRequirementPage,
  type DesiredSolution,
  type SolutionBlock,
  type RequirementPageOperation,
  type RequirementPageSnapshot,
  type RequirementSection,
} from "./blocks/requirement-page.js";
import { archiveBlock, type NotionGateway } from "./gateway.js";
import { shouldSuppressSystemProjection } from "./intent-interpreter.js";
import type { NotionOutboxDelivery, NotionOutboxRecord } from "./outbox.js";
import schema from "./notion-schema.json" with { type: "json" };
import { quietText, requirementSectionForTitle, requirementSectionTitle } from "./display-text.js";
import {
  bold,
  bullet,
  callout,
  code,
  heading2,
  heading3,
  italic,
  link,
  numbered,
  paragraph,
  quote,
  runs,
  t,
  todo,
  toggle,
  type Block,
} from "./rich-text.js";

// Headings this page no longer has. An older build wrote the metadata into a
// section of its own, copied the person's words under a heading next to them,
// and kept a waiting section that the callout now carries.
const RETIRED_TITLES = new Set(["\u5143\u4fe1\u606f", "\u539f\u59cb\u9700\u6c42", "\u5f85\u4eba\u56de\u7b54", "\u9700\u8981\u4f60\u5904\u7406"]);

const desiredSchema = z.object({
  callout: z.string(),
  original: z.string(),
  clarify: z.array(z.object({
    round: z.number().int().positive(),
    line: z.string().min(1),
    items: z.array(z.object({
      question: z.string(),
      options: z.array(z.string()),
      answer: z.string().optional(),
      reading: z.string().optional(),
    })),
  })),
  prd: z.object({
    goal: z.string(),
    nonGoals: z.array(z.string()),
    scenarios: z.array(z.object({
      id: z.string().min(1),
      given: z.string(),
      when: z.string(),
      // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external PRD contract.
      then: z.string(),
    })),
    openQuestions: z.array(z.string()),
    frozen: z.boolean(),
  }).nullable(),
  solution: z.object({
    approach: z.object({
      summary: z.string(),
      alternatives: z.array(z.object({ option: z.string(), reason: z.string() })),
    }),
    direction: z.object({
      summary: z.string(),
      alternatives: z.array(z.object({ option: z.string(), reason: z.string() })),
    }).nullable(),
    stackChanges: z.array(z.object({
      kind: z.string(),
      name: z.string(),
      reason: z.string(),
      impact: z.string(),
    })),
    qualityGates: z.array(z.object({ name: z.string(), covers: z.string() })),
    pages: z.array(z.object({
      name: z.string(),
      purpose: z.string(),
      scenarios: z.array(z.string()),
      visible: z.array(z.string()),
    })),
    prototypeUrl: z.string().nullable(),
    concerns: z.array(z.string()),
    openDecisions: z.array(z.object({ question: z.string(), recommendation: z.string() })),
    confirmed: z.boolean(),
  }).nullable(),
  delivery: z.string(),
}) as unknown as z.ZodType<DesiredRequirementPage>;
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

function paragraphBody(content: string): Record<string, unknown> {
  return { object: "block", type: "paragraph", paragraph: { rich_text: richText(content) } };
}

function calloutBlock(quiet: { icon: string; color: string; action: string }): Record<string, unknown> {
  return {
    object: "block",
    type: "callout",
    callout: { rich_text: richText(quiet.action), icon: { type: "emoji", emoji: quiet.icon }, color: quiet.color },
  };
}

function textOf(item: NotionBlock): string {
  const value = item[item.type];
  const parsed = z.object({ rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()) })
    .passthrough().safeParse(value);
  return parsed.success ? parsed.data.rich_text.map((part) => part.plain_text).join("") : "";
}

/**
 * What one clarification round holds: the question as asked, the options a
 * person picked a letter from, and their reply with what the letters meant.
 * Nothing is paraphrased -- a paraphrase would quietly become the requirement.
 */
function roundChildren(round: DesiredClarifyRound): Block[] {
  const blocks: Block[] = [];
  for (const [index, item] of round.items.entries()) {
    blocks.push(paragraph(bold(`\u95ee ${index + 1}\u3001${item.question}`)));
    if (item.options.length > 0) blocks.push(quote(t(item.options.join("\n"))));
    if (item.answer !== undefined) {
      blocks.push(paragraph(t(`\u7b54\uff1a${item.answer}`)));
      const reading = item.reading?.slice(item.answer.length).trim();
      if (reading) blocks.push(paragraph(italic(reading)));
    }
  }
  return blocks;
}

/** The PRD as a person judges it: what it is for, what it is not, and one
 * numbered scenario at a time with its own three lines underneath. */
function prdBlocks(prd: DesiredPrd): Block[] {
  const blocks: Block[] = [];
  if (prd.frozen) blocks.push(callout(t(prdFrozenLine()), "\u2705", "green_background"));
  blocks.push(paragraph(t(prd.goal)));
  for (const item of prd.nonGoals) blocks.push(paragraph(t(`\u4e0d\u505a\uff1a${item}`)));
  for (const [index, scenario] of prd.scenarios.entries()) {
    blocks.push(numbered(
      runs(t(`\u573a\u666f ${index + 1} \u00b7 ${scenario.then} `), code(scenario.id)),
      [
        paragraph(t(`\u524d\u63d0\uff1a${scenario.given}`)),
        paragraph(t(`\u64cd\u4f5c\uff1a${scenario.when}`)),
        paragraph(t(`\u7ed3\u679c\uff1a${scenario.then}`)),
      ],
    ));
  }
  for (const question of prd.openQuestions) blocks.push(paragraph(t(`\u7b49\u4f60\u88c1\u51b3\uff1a${question}`)));
  return blocks;
}

/**
 * The solution section as Notion blocks. The mapping is one block per declared
 * line, so what the planner compared and what the page shows are the same list
 * read twice.
 */
function solutionBlockOf(entry: SolutionBlock): Block {
  switch (entry.kind) {
    case "heading": {
      return heading3(t(entry.line));
    }
    case "label": {
      return paragraph(bold(entry.line));
    }
    case "bullet": {
      return bullet(t(entry.line));
    }
    case "note": {
      return callout(t(entry.line), "\u2705", "green_background");
    }
    case "link": {
      return paragraph(entry.url === undefined ? t(entry.line) : link(entry.line, entry.url));
    }
    case "page": {
      return toggle(bold(entry.line), (entry.children ?? []).map((child) => paragraph(t(child))));
    }
    case "todo": {
      return todo(t(entry.line), entry.checked === true);
    }
    default: {
      return paragraph(t(entry.line));
    }
  }
}

function solutionSectionBlocks(solution: DesiredSolution): Block[] {
  return solutionBlocks(solution).map((entry) => solutionBlockOf(entry));
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
      const operations = planRequirementPageUpdate(snapshot, payload.desired);
      if (operations.length === 0) break;
      await this.apply(payload.pageId, payload.desired, snapshot, operations);
    }
    await this.syncStatus(payload.requirementId, payload.pageId, payload.status);
  }

  private async apply(
    pageId: string,
    desired: DesiredRequirementPage,
    snapshot: RequirementPageSnapshot,
    operations: readonly RequirementPageOperation[],
  ): Promise<void> {
    const missingSections = REQUIREMENT_SECTION_ORDER.filter((section) =>
      operations.some((operation) => operation.type === "create_section" && operation.section === section));
    if (missingSections.length > 0) {
      const opening: Block[] = [];
      if (Object.keys(snapshot.sections).length === 0) {
        // A block can only be appended after another one, so everything a page
        // built from nothing needs above its first heading is written in the
        // same call, in the order the design lays it out: the request, then
        // the callout, then the headings.
        const preface = operations.find((operation) => operation.type === "insert_preface");
        if (preface?.type === "insert_preface") opening.push(paragraph(t(preface.content)));
        const top = operations.find((operation) => operation.type === "insert_callout");
        const quiet = quietText();
        if (top?.type === "insert_callout" && snapshot.preface.length === 0) {
          opening.push(callout(t(top.content), quiet.icon, quiet.color));
        }
        await this.append(pageId, [
          ...opening,
          ...missingSections.map((section) => heading2(t(requirementSectionTitle(section)))),
        ]);
        return;
      }
      // A page that already has some of its headings gets one at a time, each
      // after whatever precedes it, so an older page ends up in the same order
      // as a new one. The caller reads the page again between passes.
      const section = missingSections[0]!;
      await this.append(
        pageId,
        [heading2(t(requirementSectionTitle(section)))],
        this.sectionAnchor(snapshot, section),
      );
      return;
    }

    const rounds = new Map(desired.clarify.map((round) => [round.round, round]));
    for (const operation of operations) {
      if (operation.type === "archive_block") {
        await archiveBlock((input) => this.gateway.request(input), operation.blockId);
      } else if (operation.type === "rename_section") {
        // The heading keeps its block, and with it every comment under it.
        await this.patch(operation.blockId, "heading_2", { rich_text: t(requirementSectionTitle(operation.section)) });
      } else if (operation.type === "update_block") {
        const quiet = quietText();
        const isCallout = snapshot.callout?.id === operation.blockId;
        await this.patch(operation.blockId, isCallout ? "callout" : "paragraph", {
          rich_text: t(operation.content),
          ...(isCallout ? { icon: { type: "emoji", emoji: quiet.icon }, color: quiet.color } : {}),
        });
      } else if (operation.type === "update_round") {
        const round = rounds.get(operation.round);
        if (!round) continue;
        await this.patch(operation.blockId, "toggle", { rich_text: t(round.line) });
        // What is behind the fold moved with the line: an answered round shows
        // the answer next to the question it answers.
        for (const child of await this.children(operation.blockId)) {
          await archiveBlock((input) => this.gateway.request(input), child.id);
        }
        await this.append(operation.blockId, roundChildren(round));
      } else if (operation.type === "insert_round") {
        const round = rounds.get(operation.round);
        if (round) await this.append(pageId, [toggle(t(round.line), roundChildren(round))], operation.afterBlockId);
      } else if (operation.type === "insert_prd") {
        if (desired.prd) await this.append(pageId, prdBlocks(desired.prd), operation.afterBlockId);
      } else if (operation.type === "insert_solution") {
        if (desired.solution) {
          await this.append(pageId, solutionSectionBlocks(desired.solution), operation.afterBlockId);
        }
      } else if (operation.type === "insert_prd_banner") {
        await this.append(pageId, [callout(t(prdFrozenLine()), "\u2705", "green_background")], operation.afterBlockId);
      } else if (operation.type === "insert_delivery") {
        await this.append(pageId, [paragraph(t(operation.content))], operation.afterBlockId);
      } else if (operation.type === "insert_preface") {
        // A card that arrived as a title alone gets the request written into
        // the page. On a page that already has headings it lands under the
        // callout, which is as close to the top as an append can reach.
        await this.append(pageId, [paragraph(t(operation.content))], snapshot.callout?.id);
      } else if (operation.type === "insert_callout") {
        const quiet = quietText();
        await this.append(
          pageId,
          [callout(t(operation.content), quiet.icon, quiet.color)],
          snapshot.preface.at(-1)?.id,
        );
      }
    }
  }

  /** The block a missing heading belongs after: the end of the nearest section
   * above it, or the top of the page when it is the first one. */
  private sectionAnchor(snapshot: RequirementPageSnapshot, section: RequirementSection): string | undefined {
    const above = REQUIREMENT_SECTION_ORDER.slice(0, REQUIREMENT_SECTION_ORDER.indexOf(section));
    for (const candidate of above.toReversed()) {
      const holder = snapshot.sections[candidate];
      if (holder) return holder.blocks.at(-1)?.id ?? holder.anchorBlockId;
    }
    return snapshot.callout?.id ?? snapshot.preface.at(-1)?.id;
  }

  private async append(parentId: string, children: Block[], after?: string): Promise<void> {
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encoded(parentId)}/children`,
      priority: "projection",
      body: { children, ...(after ? { after } : {}) },
    });
  }

  private async patch(blockId: string, type: string, body: Record<string, unknown>): Promise<void> {
    await this.gateway.request({
      method: "PATCH",
      path: `/v1/blocks/${encoded(blockId)}`,
      priority: "projection",
      body: { [type]: body },
    });
  }

  private async children(blockId: string): Promise<NotionBlock[]> {
    const response = await this.gateway.request({
      method: "GET",
      path: `/v1/blocks/${encoded(blockId)}/children?page_size=100`,
      priority: "projection",
    });
    return listSchema.parse(response.data).results.filter((block) => !block.archived);
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

  /**
   * The page as it stands: what the person wrote before any heading, the
   * callout at the top, and each section this projection owns. Headings an
   * older build wrote are collected so their blocks can go.
   */
  private async readPage(pageId: string): Promise<RequirementPageSnapshot> {
    const sections: RequirementPageSnapshot["sections"] = {};
    const preface: Array<{ id: string; content: string }> = [];
    const retired: string[] = [];
    let top: { id: string; content: string } | undefined;
    let current: RequirementSection | undefined;
    let inRetired = false;
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
        const content = textOf(block);
        if (block.type === "heading_2") {
          const section = requirementSectionForTitle(content);
          current = section;
          inRetired = section === undefined;
          if (section) {
            sections[section] = { anchorBlockId: block.id, title: content, blocks: [] };
          } else if (RETIRED_TITLES.has(content.trim())) {
            retired.push(block.id);
          }
          continue;
        }
        if (block.type === "callout" && !top) {
          top = { id: block.id, content };
          continue;
        }
        if (inRetired) {
          retired.push(block.id);
          continue;
        }
        const holder = current ? sections[current] : undefined;
        if (!current || !holder) {
          // Before any heading: the words the person wrote themselves.
          if (!current) preface.push({ id: block.id, content });
          continue;
        }
        sections[current] = { ...holder, blocks: [...holder.blocks, { id: block.id, content }] };
      }
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return { preface, sections, retired, ...(top ? { callout: top } : {}) };
  }

  private async rememberAnchors(requirementId: string, snapshot: RequirementPageSnapshot): Promise<void> {
    const anchors: Array<[string, string]> = [
      ...(snapshot.callout ? [["callout", snapshot.callout.id] as [string, string]] : []),
      ...Object.entries(snapshot.sections).flatMap(([section, holder]) =>
        holder ? [[section, holder.anchorBlockId] as [string, string]] : []),
    ];
    for (const [section, anchorBlockId] of anchors) {
      await this.client.execute({
        sql: `INSERT INTO requirement_notion_sections (requirement_id, section, anchor_block_id)
              VALUES (?, ?, ?)
              ON CONFLICT(requirement_id, section) DO UPDATE SET anchor_block_id = excluded.anchor_block_id`,
        args: [requirementId, section, anchorBlockId],
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
      [names.taskId]: { rich_text: [text(payload.epicId)] },
      [names.requirementRelation]: { relation: [{ id: String(requirement.notion_page_id) }] },
    };
    const created = await this.gateway.request({
      method: "POST",
      path: "/v1/pages",
      priority: "interaction",
      body: {
        parent: { type: "data_source_id", data_source_id: this.epicsDataSourceId },
        properties,
        // The callout is created with the page: a block can only be appended
        // after another one, so the only way it sits at the top is to be there
        // from the start.
        children: [
          calloutBlock(quietText()),
          ...payload.body.split("\n\n").map((part) => paragraphBody(part)),
        ],
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
        // The id lives in its own property; the title prefix is only how pages
        // created before that property carried it, so it stays as a fallback.
        filter: {
          or: [
            { property: schema.propertyNames.taskId, rich_text: { equals: epicId } },
            { property: schema.propertyNames.title, title: { starts_with: `${epicId} ` } },
          ],
        },
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
