import { z } from "zod";
import type {
  ApprovalRequest,
  Board,
  BoardStatus,
  Gate,
  HumanInput,
  Question,
  Report,
  Submission,
} from "../../ports.ts";
import { NotionError, type NotionTransport } from "./http.ts";
import {
  ARRAY_LIMIT,
  code,
  heading,
  paragraphs,
  plainText,
  safeCut,
  text,
  todo,
  toggle,
  type Block,
  type RichTextRun,
} from "./rich-text.ts";

/**
 * The board on Notion. A requirement is a page in one data source; the adapter
 * talks to people through that page only: sections appended at its end, page
 * comments, and the system-owned status (plus an optional note). Everything a
 * person owns on the page, the title, the body and the target repository
 * included, is only ever read. A person moving the card to another column is
 * not an input: the next status write puts it back.
 *
 * Notion API behaviors this relies on:
 * - Blocks can only be appended after existing ones, one append nests at most
 *   two levels, and every array in a request (children, runs of one rich text)
 *   holds at most 100 elements; a request carries at most 1000 blocks and
 *   500KB. Each section is therefore exactly one append at the end of the page,
 *   so it is either wholly there or not at all, and text too long for one
 *   request is cut with a note saying so.
 * - The children listing can lag right after an append. A write this process
 *   already made is answered from memory rather than from the listing; a fresh
 *   process re-issuing a write seconds after a lost response can still
 *   duplicate a section.
 * - A page or block a person deleted answers 404 (`object_not_found`), which
 *   reaches the caller as a NotionError with that status.
 * - Comment `created_time` has minute precision, and only unresolved comments
 *   are listed: a thread a person resolves disappears, answers included.
 * - Select option colors can only be set when the option is created. A status
 *   label the data source lacks is created by Notion on first write with a
 *   default color, and removing an option clears it on every page holding it,
 *   so an old label is left in place rather than deleted to rename it.
 * - An @mention written through the API does not push a notification, so the
 *   board is not an alerting channel; nothing here mentions anyone.
 */

/** Every word this adapter puts in front of a person, and the names of the
 * requirements data source's own properties it reads and writes. People read
 * them, so they come from configuration in the language people use. */
export interface NotionBoardText {
  properties: {
    title: string;
    /** A select naming a registered repository. A page without one stays on the board untouched. */
    repository: string;
    /** The system-owned select. An empty one marks a submission not taken in yet. */
    status: string;
    /** A select naming the recipe the submitter asked for; without it every submission lets the loop choose. */
    recipe?: string | undefined;
    /** A system-owned rich text written beside the status; without it the note is dropped. */
    note?: string | undefined;
  };
  status: Record<BoardStatus, string>;
  /** Between an approval section's title and its short revision. */
  version: string;
  /** The label of the box a person ticks to approve. */
  approve: string;
  replyWithOption: string;
  reply: string;
  /** Appended where a section had to be cut to fit one request. */
  truncated: string;
}

export interface NotionBoardOptions {
  /** The process's one Notion transport, which owns the rate budget. */
  transport: NotionTransport;
  requirementsDataSourceId: string;
  /** The integration's own user: what it wrote is never read back as a person's input. */
  botUserId: string;
  text: NotionBoardText;
}

const GATES: readonly Gate[] = ["product", "architecture", "milestone"];

/**
 * The stable key a section or question carries on the page, as inline code.
 * Parts are URI-encoded so a marker never holds whitespace or a colon of its
 * own, and markers are compared whole: a substring test would find `q-1`
 * inside `q-10` and skip a question nobody was asked.
 */
function markerFor(kind: "approval" | "question" | "report", ...parts: string[]): string {
  return ["hivemind", kind, ...parts.map((part) => encodeURIComponent(part))].join(":");
}

const MARKER_TOKEN = /hivemind:(?:approval|question|report):\S+/g;

function markersIn(words: string): string[] {
  return words.match(MARKER_TOKEN) ?? [];
}

function approvalOf(marker: string): { gate: Gate; revision: string } | null {
  const [prefix, kind, gatePart, revisionPart, ...rest] = marker.split(":");
  const gate = GATES.find((candidate) => candidate === gatePart);
  if (prefix !== "hivemind" || kind !== "approval" || gate === undefined || revisionPart === undefined) return null;
  if (rest.length > 0) return null;
  try {
    return { gate, revision: decodeURIComponent(revisionPart) };
  } catch {
    // URIError: a person edited the marker into something no write of ours
    // produced, so the box binds to no revision and is not an approval.
    return null;
  }
}

const MINUTE_MS = 60_000;
/** How far behind the cursor comments are read again: created_time is floored
 * to the minute, so a comment written seconds after the cursor can carry an
 * older stamp than the cursor itself. */
const COMMENT_OVERLAP_MS = 2 * MINUTE_MS;

/** Below Notion's 500KB so the rest of the request never tips it over. */
const REQUEST_BYTES = 400_000;
const REQUEST_BLOCKS = 1_000;
/** Characters of text kept across a section that has to be cut to fit one
 * request: at most four bytes each, and room for the block structure. */
const CUT_CHARACTERS = 80_000;

/** How deep a submission's body is read: nested lists and toggle contents. */
const BODY_DEPTH = 3;
/** Blocks whose children are another page, not the requirement's text. */
const OTHER_PAGES = new Set(["child_page", "child_database"]);

const userRef = z.looseObject({ id: z.string() });

const blockSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  created_time: z.string(),
  last_edited_time: z.string(),
  last_edited_by: userRef.optional(),
  has_children: z.boolean().optional(),
  archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
});
type NotionBlock = z.infer<typeof blockSchema>;

const commentSchema = z.looseObject({
  id: z.string(),
  created_time: z.string(),
  created_by: userRef,
  rich_text: z.array(z.unknown()),
});
type NotionComment = z.infer<typeof commentSchema>;

const pageSchema = z.looseObject({
  id: z.string(),
  created_time: z.string(),
  created_by: userRef.optional(),
  archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
  properties: z.record(z.string(), z.unknown()),
});

const selectSchema = z.object({ select: z.object({ name: z.string() }).nullable() });
const titleSchema = z.object({ title: z.array(z.unknown()) });
const userSchema = z.looseObject({ name: z.string().nullable().optional() });

function listSchema<T>(item: z.ZodType<T>) {
  return z.object({
    results: z.array(item),
    has_more: z.boolean().optional(),
    next_cursor: z.string().nullable().optional(),
  });
}

async function collect<T>(item: z.ZodType<T>, fetchPage: (cursor: string | null) => Promise<unknown>): Promise<T[]> {
  const schema = listSchema(item);
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const page = schema.parse(await fetchPage(cursor));
    all.push(...page.results);
    cursor = page.has_more === true && page.next_cursor ? page.next_cursor : null;
  } while (cursor !== null);
  return all;
}

function payloadOf(block: NotionBlock): object | null {
  const payload = block[block.type];
  return typeof payload === "object" && payload !== null ? payload : null;
}

/** The words a block carries: its rich text, a table row's cells, or a link. */
function blockWords(block: NotionBlock): string {
  const payload = payloadOf(block);
  if (payload === null) return "";
  if ("rich_text" in payload) return plainText(payload.rich_text);
  if ("cells" in payload && Array.isArray(payload.cells)) {
    return payload.cells.map((cell: unknown) => plainText(cell)).join(" | ");
  }
  return "url" in payload && typeof payload.url === "string" ? payload.url : "";
}

function isChecked(block: NotionBlock): boolean {
  const payload = payloadOf(block);
  return payload !== null && "checked" in payload && payload.checked === true;
}

/** One line of a submission's body, marked up the way the block reads. */
function bodyLine(block: NotionBlock, number: number): string | null {
  const words = blockWords(block).trim();
  if (words === "") return null;
  switch (block.type) {
    case "heading_1": return `# ${words}`;
    case "heading_2": return `## ${words}`;
    case "heading_3": return `### ${words}`;
    case "bulleted_list_item": return `- ${words}`;
    case "numbered_list_item": return `${number}. ${words}`;
    case "to_do": return `[${isChecked(block) ? "x" : " "}] ${words}`;
    case "quote": return `> ${words}`;
    case "code": return `\`\`\`\n${words}\n\`\`\``;
    default: return words;
  }
}

function selectName(value: unknown): string | null {
  const parsed = selectSchema.safeParse(value);
  return parsed.success ? parsed.data.select?.name.trim() || null : null;
}

function iso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Notion returned an unreadable timestamp: ${value}`);
  return new Date(time).toISOString();
}

function childrenPath(blockId: string, cursor: string | null): string {
  const query = new URLSearchParams({ page_size: "100" });
  if (cursor) query.set("start_cursor", cursor);
  return `/v1/blocks/${encodeURIComponent(blockId)}/children?${query.toString()}`;
}

function blockPayload(block: Block): { rich_text?: unknown[]; children?: Block[] } {
  return block[block.type] as { rich_text?: unknown[]; children?: Block[] };
}

function countBlocks(blocks: readonly Block[]): number {
  return blocks.reduce((total, block) => total + 1 + countBlocks(blockPayload(block).children ?? []), 0);
}

function withinArrayLimits(blocks: readonly Block[]): boolean {
  return blocks.length <= ARRAY_LIMIT && blocks.every((block) => {
    const payload = blockPayload(block);
    return (payload.rich_text?.length ?? 0) <= ARRAY_LIMIT && withinArrayLimits(payload.children ?? []);
  });
}

function fitsOneRequest(blocks: readonly Block[]): boolean {
  return withinArrayLimits(blocks)
    && countBlocks(blocks) <= REQUEST_BLOCKS
    && new TextEncoder().encode(JSON.stringify({ children: blocks })).byteLength <= REQUEST_BYTES;
}

type Cut = (content: string) => string;

/**
 * Builds a section as one append request. Text that cannot fit is cut, the
 * same share for each of its `texts` long texts, rather than written over
 * several appends: a section split across requests can be left half written,
 * and a half-written approval would ask a person to approve what they cannot
 * see.
 */
function oneRequest(build: (cut: Cut) => Block[], texts: number, truncated: string): Block[] {
  const whole = build((content) => content);
  if (fitsOneRequest(whole)) return whole;
  const limit = Math.floor(CUT_CHARACTERS / Math.max(1, texts));
  const shortened = build((content) =>
    content.length <= limit ? content : `${content.slice(0, safeCut(content, limit))}\n\n${truncated}`);
  if (fitsOneRequest(shortened)) return shortened;
  throw new Error(`a board section of ${shortened.length} blocks does not fit one Notion request`);
}

function approvalBlocks(request: ApprovalRequest, marker: string, words: NotionBoardText): Block[] {
  const documents = Math.max(1, request.documents.length);
  const documentBlocks = Math.min(ARRAY_LIMIT, Math.floor((REQUEST_BLOCKS - ARRAY_LIMIT) / documents));
  const summaryBlocks = Math.max(1, ARRAY_LIMIT - 2 - request.documents.length);
  return oneRequest((cut) => [
    heading(text(`${request.title}${words.version}${request.revision.slice(0, 7)}`)),
    ...paragraphs(cut(request.summary), summaryBlocks),
    ...request.documents.map((document) => toggle(text(document.name), paragraphs(cut(document.content), documentBlocks))),
    // The box carries the full marker: it is the block an approval is read
    // back from, so it binds the tick to this exact revision wherever a
    // person drags it.
    todo([...text(words.approve), ...code(marker)]),
  ], 1 + request.documents.length, words.truncated);
}

function reportBlocks(report: Report, marker: string, words: NotionBoardText): Block[] {
  return oneRequest((cut) => [
    heading([...text(`${report.title} `), ...code(marker)]),
    ...paragraphs(cut(report.body), ARRAY_LIMIT - 1),
  ], 1, words.truncated);
}

function questionRuns(question: Question, marker: string, words: NotionBoardText): RichTextRun[] {
  const lines = [question.body.trim()];
  if (question.options.length > 0) {
    lines.push("", ...question.options.map((option, index) => `${index + 1}. ${option}`));
  }
  lines.push("", question.options.length > 0 ? words.replyWithOption : words.reply, "");
  return [...text(lines.join("\n")).slice(0, ARRAY_LIMIT - 1), ...code(marker)];
}

export function createNotionBoard(options: NotionBoardOptions): Board {
  const { transport, botUserId, text: words } = options;
  const names = {
    title: words.properties.title,
    repository: words.properties.repository,
    status: words.properties.status,
    recipe: words.properties.recipe ?? null,
    note: words.properties.note ?? null,
  };
  const labels = words.status;
  /** Markers this process wrote or saw, per page: re-issued writes are answered here. */
  const written = new Set<string>();
  const people = new Map<string, string>();

  async function listChildren(blockId: string): Promise<NotionBlock[]> {
    const blocks = await collect(blockSchema, (cursor) => transport({ method: "GET", path: childrenPath(blockId, cursor) }));
    return blocks.filter((block) => block.archived !== true && block.in_trash !== true);
  }

  function listComments(pageId: string): Promise<NotionComment[]> {
    return collect(commentSchema, (cursor) => {
      const query = new URLSearchParams({ block_id: pageId, page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      return transport({ method: "GET", path: `/v1/comments?${query.toString()}` });
    });
  }

  async function append(pageId: string, children: Block[]): Promise<void> {
    await transport({ method: "PATCH", path: `/v1/blocks/${encodeURIComponent(pageId)}/children`, body: { children } });
  }

  /** A person's name, or their id when the workspace will not say. Never throws:
   * a name is presentation and never worth losing an input over. */
  async function displayName(userId: string): Promise<string> {
    const known = people.get(userId);
    if (known !== undefined) return known;
    try {
      const user = userSchema.parse(await transport({ method: "GET", path: `/v1/users/${encodeURIComponent(userId)}` }));
      const name = user.name?.trim() || userId;
      people.set(userId, name);
      return name;
    } catch (error) {
      // A refusal (the integration may not read users) or an unknown user is
      // a lasting answer and is remembered; a network fault or a malformed
      // reply is asked about again next time.
      if (error instanceof NotionError && (error.status === 403 || error.status === 404)) people.set(userId, userId);
      return userId;
    }
  }

  async function readBody(blockId: string, depth: number): Promise<string[]> {
    const lines: string[] = [];
    let number = 0;
    for (const block of await listChildren(blockId)) {
      number = block.type === "numbered_list_item" ? number + 1 : 0;
      const line = bodyLine(block, number);
      if (line !== null) lines.push(`${"  ".repeat(depth)}${line}`);
      if (block.has_children === true && depth < BODY_DEPTH && !OTHER_PAGES.has(block.type)) {
        lines.push(...await readBody(block.id, depth + 1));
      }
    }
    return lines;
  }

  /** Whether a top-level block of the page carries the marker. */
  async function onPage(pageId: string, marker: string): Promise<boolean> {
    const key = `${pageId} ${marker}`;
    if (written.has(key)) return true;
    const found = (await listChildren(pageId)).some((block) => markersIn(blockWords(block)).includes(marker));
    if (found) written.add(key);
    return found;
  }

  return {
    async pollSubmissions() {
      const filter = {
        and: [
          { property: names.status, select: { is_empty: true } },
          { property: names.repository, select: { is_not_empty: true } },
        ],
      };
      const results = await collect(z.unknown(), (cursor) => transport({
        method: "POST",
        path: `/v1/data_sources/${encodeURIComponent(options.requirementsDataSourceId)}/query`,
        body: {
          filter,
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
      }));

      const submissions: Submission[] = [];
      for (const result of results) {
        // A data source can list other data sources beside its pages.
        if (typeof result === "object" && result !== null && "object" in result && result.object !== "page") continue;
        const page = pageSchema.parse(result);
        if (page.archived === true || page.in_trash === true) continue;
        const titleProperty = page.properties[names.title]
          ?? Object.values(page.properties).find((property) => titleSchema.safeParse(property).success);
        const title = plainText(titleSchema.safeParse(titleProperty).data?.title).trim();
        const repo = selectName(page.properties[names.repository]);
        // A card without a title is still being written, and one without a
        // repository cannot be placed: both stay on the board untouched.
        if (title === "" || repo === null) continue;
        submissions.push({
          ref: page.id,
          title,
          body: (await readBody(page.id, 0)).join("\n"),
          repo,
          recipe: names.recipe === null ? null : selectName(page.properties[names.recipe]),
          author: page.created_by ? await displayName(page.created_by.id) : null,
          submittedAt: iso(page.created_time),
        });
      }
      return submissions;
    },

    async requestApproval(ref, request) {
      const marker = markerFor("approval", request.gate, request.revision);
      if (await onPage(ref, marker)) return;
      await append(ref, approvalBlocks(request, marker, words));
      written.add(`${ref} ${marker}`);
    },

    async ask(ref, question) {
      const marker = markerFor("question", question.id);
      const key = `${ref} ${marker}`;
      if (written.has(key)) return;
      if ((await listComments(ref)).some((comment) => markersIn(plainText(comment.rich_text)).includes(marker))) {
        written.add(key);
        return;
      }
      await transport({
        method: "POST",
        path: "/v1/comments",
        body: { parent: { page_id: ref }, rich_text: questionRuns(question, marker, words) },
      });
      written.add(key);
    },

    async report(ref, report) {
      const marker = markerFor("report", report.id);
      if (await onPage(ref, marker)) return;
      await append(ref, reportBlocks(report, marker, words));
      written.add(`${ref} ${marker}`);
    },

    async pollInputs(ref, cursor) {
      const since = cursor === null ? Number.NaN : Date.parse(cursor);
      const cutoff = Number.isFinite(since)
        ? since - (since % MINUTE_MS) - COMMENT_OVERLAP_MS
        : Number.NEGATIVE_INFINITY;
      let newest = Number.NEGATIVE_INFINITY;
      const inputs: HumanInput[] = [];

      for (const comment of await listComments(ref)) {
        const at = Date.parse(comment.created_time);
        if (!Number.isFinite(at)) throw new Error(`Notion comment ${comment.id} has an unreadable created_time`);
        newest = Math.max(newest, at);
        if (comment.created_by.id === botUserId || at < cutoff) continue;
        inputs.push({
          kind: "comment",
          sourceId: comment.id,
          body: plainText(comment.rich_text),
          author: await displayName(comment.created_by.id),
          at: new Date(at).toISOString(),
        });
      }

      for (const block of await listChildren(ref)) {
        if (block.type !== "to_do" || !isChecked(block)) continue;
        const approval = markersIn(blockWords(block)).map(approvalOf).find((found) => found !== null);
        if (!approval) continue;
        inputs.push({
          kind: "approval",
          sourceId: `${block.id}:${approval.revision}`,
          gate: approval.gate,
          revision: approval.revision,
          // Whoever last edited the box ticked it: the adapter creates it
          // unticked and never edits it again.
          author: block.last_edited_by ? await displayName(block.last_edited_by.id) : null,
          at: iso(block.last_edited_time),
        });
      }

      const advanced = newest > (Number.isFinite(since) ? since : Number.NEGATIVE_INFINITY);
      return {
        inputs: inputs.toSorted((left, right) =>
          left.at.localeCompare(right.at) || left.sourceId.localeCompare(right.sourceId)),
        cursor: advanced ? new Date(newest).toISOString() : cursor,
      };
    },

    async setStatus(ref, status, note) {
      const properties: Record<string, unknown> = { [names.status]: { select: { name: labels[status] } } };
      if (names.note !== null) properties[names.note] = { rich_text: note === null ? [] : text(note).slice(0, ARRAY_LIMIT) };
      await transport({ method: "PATCH", path: `/v1/pages/${encodeURIComponent(ref)}`, body: { properties } });
    },
  };
}
