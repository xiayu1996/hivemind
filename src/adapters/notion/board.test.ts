import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../ports.ts";
import { createNotionBoard, type NotionBoardOptions, type NotionBoardText } from "./board.ts";
import { NotionError, type NotionRequest, type NotionTransport } from "./http.ts";

type Json = Record<string, unknown>;

const BOT = "bot-user";
const PERSON = "person-1";
const DATA_SOURCE = "requirements-ds";
const BOARD_TEXT: NotionBoardText = {
  properties: { title: "Title", repository: "Repository", status: "Status" },
  status: { queued: "Queued", working: "Working", needs_input: "Needs input", stopped: "Stopped", done: "Done" },
  version: " / version ",
  approve: "Approve this version ",
  replyWithOption: "Reply to this comment with the number of an option, or with your own answer.",
  reply: "Reply to this comment.",
  truncated: "(Cut to fit; the full text is in the repository at this version.)",
};
const NAMES = BOARD_TEXT.properties;
const REVISION = "3f2a9c1e5b7d0a4c8e6f2b1d9a3c5e7f0b2d4a6c";
const LATER_REVISION = "8b1d0e4f2a6c9e3b5d7f1a0c2e4b6d8f3a5c7e9b";

/** The requirements data source as bootstrapped, plus a recipe select, a note
 * and a property only a person writes. */
const SCHEMA: Record<string, string> = {
  [NAMES.title]: "title",
  [NAMES.status]: "select",
  [NAMES.repository]: "select",
  Recipe: "select",
  Note: "rich_text",
  Priority: "select",
};

function minute(time: number): string {
  return new Date(time - (time % 60_000)).toISOString();
}

function run(content: string): Json {
  return { type: "text", text: { content } };
}

/** Rich text as Notion returns it: every run carries its plain text. */
function returned(runs: unknown): Json[] {
  return (runs as Json[]).map((item) => Object.assign(structuredClone(item), {
    annotations: Object.assign(
      { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
      item.annotations,
    ),
    plain_text: ((item.text as Json | undefined)?.content as string | undefined) ?? "",
    href: null,
  }));
}

function selectValue(name: string | undefined): Json {
  return { type: "select", select: name ? { id: `option-${name}`, name, color: "default" } : null };
}

function blockSpec(type: string, content: string, extra: Json = {}): Json {
  return { object: "block", type, [type]: { rich_text: [run(content)], ...extra } };
}

const para = (content: string): Json => blockSpec("paragraph", content);
const bullet = (content: string, children: Json[] = []): Json =>
  blockSpec("bulleted_list_item", content, children.length > 0 ? { children } : {});
const numbered = (content: string): Json => blockSpec("numbered_list_item", content);
const checkbox = (content: string, checked: boolean): Json => blockSpec("to_do", content, { checked });
const heading1 = (content: string): Json => blockSpec("heading_1", content);

function refusal(request: NotionRequest, status: number, code: string, message: string): NotionError {
  return new NotionError(`${request.method} ${request.path} failed with status ${status} ${code}: ${message}`, status, code);
}

interface PageInput {
  title: string;
  status?: string;
  repository?: string;
  recipe?: string;
  createdTime?: string;
  body?: Json[];
}

/**
 * A Notion workspace holding the requirements data source. It answers in the
 * shapes the real API uses and refuses what the real API refuses: arrays over
 * 100, runs over 2000 characters, nesting deeper than one append allows, an
 * empty children array, requests over 1000 blocks or 500KB, unknown
 * properties and deleted pages.
 */
class FakeNotion {
  readonly requests: NotionRequest[] = [];
  readonly users = new Map<string, string | null>([[PERSON, "Ryan Xia"]]);
  forbidUsers = false;
  pageSize = 100;
  /** The next listing of a page after an append still shows the page before it. */
  lagAppends = false;
  now = Date.parse("2026-09-24T10:00:00.000Z");
  private readonly pages = new Map<string, Json>();
  private readonly blocks = new Map<string, Json>();
  private readonly children = new Map<string, string[]>();
  private readonly stale = new Map<string, string[]>();
  private readonly comments: Json[] = [];
  private nextId = 1;

  readonly transport: NotionTransport = async (request) => {
    this.requests.push(structuredClone(request));
    return structuredClone(this.route(request));
  };

  addPage(input: PageInput): string {
    const id = `page-${this.nextId++}`;
    const created = input.createdTime ?? minute(this.now);
    this.pages.set(id, {
      object: "page",
      id,
      created_time: created,
      last_edited_time: created,
      created_by: { object: "user", id: PERSON },
      last_edited_by: { object: "user", id: PERSON },
      parent: { type: "data_source_id", data_source_id: DATA_SOURCE, database_id: "requirements-db" },
      archived: false,
      in_trash: false,
      properties: {
        [NAMES.title]: { id: "title", type: "title", title: returned([run(input.title)]).filter(() => input.title !== "") },
        [NAMES.status]: { id: "status", ...selectValue(input.status) },
        [NAMES.repository]: { id: "repository", ...selectValue(input.repository) },
        Recipe: { id: "recipe", ...selectValue(input.recipe) },
        Note: { id: "note", type: "rich_text", rich_text: [] },
        Priority: { id: "priority", ...selectValue("P1") },
      },
      url: `https://www.notion.so/${id}`,
    });
    this.children.set(id, []);
    for (const block of input.body ?? []) this.insert(id, block, PERSON);
    return id;
  }

  addComment(pageId: string, author: string, body: string, time: string): string {
    const id = `comment-${this.nextId++}`;
    this.comments.push({
      object: "comment",
      id,
      parent: { type: "page_id", page_id: pageId },
      discussion_id: `discussion-${id}`,
      created_time: time,
      last_edited_time: time,
      created_by: { object: "user", id: author },
      rich_text: returned([run(body)]),
    });
    return id;
  }

  /** A person ticking a box in the app. */
  tick(blockId: string): void {
    const block = this.blocks.get(blockId)!;
    (block.to_do as Json).checked = true;
    block.last_edited_by = { object: "user", id: PERSON };
    block.last_edited_time = minute(this.now);
  }

  /** A person deleting a page or block in the app. */
  trash(id: string): void {
    const target = this.pages.get(id) ?? this.blocks.get(id)!;
    target.in_trash = true;
  }

  property(pageId: string, name: string): unknown {
    return (this.pages.get(pageId)!.properties as Json)[name];
  }

  /** The page's top-level blocks as a person sees them. */
  outline(pageId: string): Array<{ type: string; text: string; checked?: boolean; children: string[] }> {
    return this.visible(pageId).map((block) => {
      const payload = block[block.type as string] as Json;
      const line: { type: string; text: string; checked?: boolean; children: string[] } = {
        type: block.type as string,
        text: this.words(block),
        children: this.visible(block.id as string).map((child) => this.words(child)),
      };
      if (block.type === "to_do") line.checked = payload.checked as boolean;
      return line;
    });
  }

  blockIds(pageId: string): string[] {
    return this.visible(pageId).map((block) => block.id as string);
  }

  commentTexts(pageId: string): string[] {
    return this.comments
      .filter((comment) => (comment.parent as Json).page_id === pageId)
      .map((comment) => (comment.rich_text as Json[]).map((item) => item.plain_text).join(""));
  }

  sent(method: string, pathPattern: RegExp): NotionRequest[] {
    return this.requests.filter((request) => request.method === method && pathPattern.test(request.path));
  }

  private words(block: Json): string {
    const payload = block[block.type as string] as Json;
    return ((payload.rich_text as Json[] | undefined) ?? []).map((item) => item.plain_text).join("");
  }

  private visible(parentId: string): Json[] {
    return (this.children.get(parentId) ?? [])
      .map((id) => this.blocks.get(id)!)
      .filter((block) => block.in_trash !== true);
  }

  private route(request: NotionRequest): unknown {
    const url = new URL(request.path, "https://api.notion.com");
    const [resource, id, action] = url.pathname.split("/").slice(2).map((part) => decodeURIComponent(part));
    const body = (request.body ?? {}) as Json;
    if (resource === "data_sources" && action === "query" && request.method === "POST") return this.query(request, id!, body);
    if (resource === "blocks" && action === "children" && request.method === "GET") {
      return this.listChildren(request, id!, url.searchParams);
    }
    if (resource === "blocks" && action === "children" && request.method === "PATCH") return this.append(request, id!, body);
    if (resource === "comments" && request.method === "GET") return this.listComments(request, url.searchParams);
    if (resource === "comments" && request.method === "POST") return this.createComment(request, body);
    if (resource === "pages" && request.method === "PATCH") return this.updatePage(request, id!, body);
    if (resource === "users" && request.method === "GET") return this.user(request, id!);
    throw new Error(`the fake Notion does not serve ${request.method} ${request.path}`);
  }

  private page<T>(items: T[], size: number, start: number, type: string): Json {
    const effective = Math.min(size, this.pageSize);
    const more = start + effective < items.length;
    return {
      object: "list",
      results: items.slice(start, start + effective),
      next_cursor: more ? `cursor-${start + effective}` : null,
      has_more: more,
      type,
      [type]: {},
    };
  }

  private cursor(value: unknown): number {
    return typeof value === "string" ? Number(value.replace("cursor-", "")) : 0;
  }

  private query(request: NotionRequest, dataSourceId: string, body: Json): Json {
    if (dataSourceId !== DATA_SOURCE) throw refusal(request, 404, "object_not_found", `Could not find data_source with ID: ${dataSourceId}.`);
    const matching = [...this.pages.values()]
      .filter((page) => page.in_trash !== true && this.matches(request, page, body.filter as Json))
      .toSorted((left, right) => String(left.created_time).localeCompare(String(right.created_time)));
    return this.page(matching, Number(body.page_size ?? 100), this.cursor(body.start_cursor), "page_or_data_source");
  }

  private matches(request: NotionRequest, page: Json, filter: Json): boolean {
    if (Array.isArray(filter.and)) return (filter.and as Json[]).every((part) => this.matches(request, page, part));
    const name = String(filter.property);
    if (!(name in SCHEMA)) throw refusal(request, 400, "validation_error", `Could not find property with name or id: ${name}`);
    const current = ((page.properties as Json)[name] as Json).select as Json | null;
    const select = filter.select as Json;
    if (select.is_empty === true) return current === null;
    if (select.is_not_empty === true) return current !== null;
    throw new Error(`the fake Notion cannot evaluate ${JSON.stringify(filter)}`);
  }

  private known(request: NotionRequest, id: string): void {
    const target = this.pages.get(id) ?? this.blocks.get(id);
    if (!target || target.in_trash === true) {
      throw refusal(request, 404, "object_not_found", `Could not find block with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`);
    }
  }

  private listChildren(request: NotionRequest, parentId: string, query: URLSearchParams): Json {
    this.known(request, parentId);
    const lagging = this.stale.get(parentId);
    this.stale.delete(parentId);
    const blocks = (lagging ?? this.children.get(parentId) ?? [])
      .map((id) => this.blocks.get(id)!)
      .filter((block) => block.in_trash !== true);
    return this.page(blocks, Number(query.get("page_size") ?? 100), this.cursor(query.get("start_cursor")), "block");
  }

  private checkRichText(request: NotionRequest, runs: unknown, where: string): void {
    const items = runs as Json[];
    if (items.length > 100) throw refusal(request, 400, "validation_error", `${where}.rich_text.length should be <= 100, instead was ${items.length}.`);
    for (const [index, item] of items.entries()) {
      const content = String((item.text as Json).content);
      if (content.length > 2_000) {
        throw refusal(request, 400, "validation_error", `${where}.rich_text[${index}].text.content.length should be <= 2000, instead was ${content.length}.`);
      }
    }
  }

  private checkBlocks(request: NotionRequest, blocks: Json[], depth: number, where: string): number {
    if (blocks.length === 0) throw refusal(request, 400, "validation_error", `${where} should be not empty.`);
    if (blocks.length > 100) throw refusal(request, 400, "validation_error", `${where}.length should be <= 100, instead was ${blocks.length}.`);
    let count = 0;
    for (const [index, block] of blocks.entries()) {
      const payload = block[block.type as string] as Json;
      this.checkRichText(request, payload.rich_text ?? [], `${where}[${index}].${String(block.type)}`);
      count += 1;
      if (payload.children !== undefined) {
        if (depth >= 2) throw refusal(request, 400, "validation_error", `${where}[${index}] nests children deeper than two levels.`);
        count += this.checkBlocks(request, payload.children as Json[], depth + 1, `${where}[${index}].${String(block.type)}.children`);
      }
    }
    return count;
  }

  private append(request: NotionRequest, parentId: string, body: Json): Json {
    this.known(request, parentId);
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 500_000) {
      throw refusal(request, 413, "payload_too_large", "Request body too large.");
    }
    const children = body.children as Json[];
    if (this.checkBlocks(request, children, 1, "body.children") > 1_000) {
      throw refusal(request, 400, "validation_error", "body.children contains more than 1000 blocks.");
    }
    if (this.lagAppends) this.stale.set(parentId, [...(this.children.get(parentId) ?? [])]);
    const created = children.map((child) => this.insert(parentId, child, BOT));
    return { object: "list", results: created, next_cursor: null, has_more: false, type: "block", block: {} };
  }

  private insert(parentId: string, spec: Json, author: string): Json {
    const id = `block-${this.nextId++}`;
    const type = spec.type as string;
    const { children, ...payload } = spec[type] as Json;
    if (payload.rich_text) payload.rich_text = returned(payload.rich_text);
    const stamp = minute(this.now);
    const nested = (children as Json[] | undefined) ?? [];
    const block: Json = {
      object: "block",
      id,
      parent: this.pages.has(parentId) ? { type: "page_id", page_id: parentId } : { type: "block_id", block_id: parentId },
      created_time: stamp,
      last_edited_time: stamp,
      created_by: { object: "user", id: author },
      last_edited_by: { object: "user", id: author },
      has_children: nested.length > 0,
      archived: false,
      in_trash: false,
      type,
      [type]: payload,
    };
    this.blocks.set(id, block);
    this.children.set(id, []);
    this.children.get(parentId)!.push(id);
    for (const child of nested) this.insert(id, child, author);
    return block;
  }

  private listComments(request: NotionRequest, query: URLSearchParams): Json {
    const pageId = query.get("block_id") ?? "";
    this.known(request, pageId);
    const onPage = this.comments.filter((comment) => (comment.parent as Json).page_id === pageId);
    return this.page(onPage, Number(query.get("page_size") ?? 100), this.cursor(query.get("start_cursor")), "comment");
  }

  private createComment(request: NotionRequest, body: Json): Json {
    const pageId = String((body.parent as Json).page_id);
    this.known(request, pageId);
    this.checkRichText(request, body.rich_text, "body");
    const id = `comment-${this.nextId++}`;
    const comment = {
      object: "comment",
      id,
      parent: { type: "page_id", page_id: pageId },
      discussion_id: `discussion-${id}`,
      created_time: minute(this.now),
      last_edited_time: minute(this.now),
      created_by: { object: "user", id: BOT },
      rich_text: returned(body.rich_text),
    };
    this.comments.push(comment);
    return comment;
  }

  private updatePage(request: NotionRequest, pageId: string, body: Json): Json {
    this.known(request, pageId);
    const page = this.pages.get(pageId)!;
    const properties = page.properties as Json;
    for (const [name, value] of Object.entries(body.properties as Json)) {
      if (!(name in SCHEMA)) throw refusal(request, 400, "validation_error", `${name} is not a property that exists.`);
      const update = value as Json;
      if (SCHEMA[name] === "select") {
        const option = update.select as Json | null;
        // Notion creates a select option it has not seen, with a default color.
        properties[name] = { id: name, type: "select", select: option ? { id: `option-${String(option.name)}`, name: option.name, color: "default" } : null };
      } else if (SCHEMA[name] === "rich_text") {
        this.checkRichText(request, update.rich_text, `body.properties.${name}`);
        properties[name] = { id: name, type: "rich_text", rich_text: returned(update.rich_text) };
      }
    }
    return page;
  }

  private user(request: NotionRequest, userId: string): Json {
    if (this.forbidUsers) throw refusal(request, 403, "restricted_resource", "Insufficient permissions for this endpoint.");
    if (!this.users.has(userId)) throw refusal(request, 404, "object_not_found", `Could not find user with ID: ${userId}.`);
    return { object: "user", id: userId, type: "person", name: this.users.get(userId) ?? null, avatar_url: null, person: { email: "ryan@example.com" } };
  }
}

function setup(overrides: Partial<NotionBoardOptions> = {}) {
  const notion = new FakeNotion();
  const options: NotionBoardOptions = {
    transport: notion.transport,
    requirementsDataSourceId: DATA_SOURCE,
    botUserId: BOT,
    text: BOARD_TEXT,
    ...overrides,
  };
  // A second board over the same workspace remembers nothing, as after a restart.
  return { notion, board: createNotionBoard(options), fresh: () => createNotionBoard(options) };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    gate: "product",
    revision: REVISION,
    title: "Acceptance criteria",
    summary: "What the finished product must visibly do.\n\nTwo items, four scenarios.",
    documents: [
      { name: "acceptance.yaml", content: "items:\n  - id: A1\n\n  - id: A2" },
      { name: "out-of-scope.md", content: "No billing." },
    ],
    ...overrides,
  };
}

describe("pollSubmissions", () => {
  it("takes in a card with an empty status and a target repository, body as the person wrote it", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({
      title: "Build an admin console",
      repository: "acme/web",
      createdTime: "2026-09-24T09:00:00.000Z",
      body: [
        heading1("Goal"),
        para("See what the agent is doing without opening the database."),
        bullet("Works on phones", [bullet("Portrait first")]),
        numbered("Log in"),
        numbered("Open the board"),
        checkbox("Dark mode", true),
        para(""),
      ],
    });
    notion.addPage({ title: "No repository picked yet" });
    notion.addPage({ title: "Already taken in", repository: "acme/web", status: BOARD_TEXT.status.working });
    notion.addPage({ title: "", repository: "acme/web" });

    await expect(board.pollSubmissions()).resolves.toEqual([{
      ref: card,
      title: "Build an admin console",
      body: [
        "# Goal",
        "See what the agent is doing without opening the database.",
        "- Works on phones",
        "  - Portrait first",
        "1. Log in",
        "2. Open the board",
        "[x] Dark mode",
      ].join("\n"),
      repo: "acme/web",
      recipe: null,
      author: "Ryan Xia",
      submittedAt: "2026-09-24T09:00:00.000Z",
    }]);
    expect(notion.sent("POST", /\/query$/)[0]?.body).toMatchObject({
      filter: {
        and: [
          { property: NAMES.status, select: { is_empty: true } },
          { property: NAMES.repository, select: { is_not_empty: true } },
        ],
      },
    });
    // Reading a card never writes to it: a page left out stays exactly as it was.
    expect(notion.requests.filter((request) => request.method !== "GET" && !request.path.endsWith("/query"))).toEqual([]);
  });

  it("returns the oldest card first and reads every page of a long listing", async () => {
    const { notion, board } = setup();
    notion.pageSize = 1;
    const later = notion.addPage({
      title: "Later",
      repository: "acme/web",
      createdTime: "2026-09-24T10:00:00.000Z",
      body: [para("one"), para("two"), para("three")],
    });
    const earlier = notion.addPage({ title: "Earlier", repository: "acme/api", createdTime: "2026-09-24T09:30:00.000Z" });

    const submissions = await board.pollSubmissions();
    expect(submissions.map((submission) => [submission.ref, submission.repo])).toEqual([[earlier, "acme/api"], [later, "acme/web"]]);
    expect(submissions[1]?.body).toBe("one\ntwo\nthree");
    expect(notion.requests.some((request) => request.path.includes("start_cursor=cursor-1"))).toBe(true);
  });

  it("reads the recipe only from a property the board was told about", async () => {
    const { notion, board } = setup({ text: { ...BOARD_TEXT, properties: { ...NAMES, recipe: "Recipe" } } });
    notion.addPage({ title: "Console", repository: "acme/web", recipe: "web-app" });
    await expect(board.pollSubmissions()).resolves.toMatchObject([{ recipe: "web-app" }]);

    const unaware = createNotionBoard({ transport: notion.transport, requirementsDataSourceId: DATA_SOURCE, botUserId: BOT, text: BOARD_TEXT });
    await expect(unaware.pollSubmissions()).resolves.toMatchObject([{ recipe: null }]);
  });
});

describe("requestApproval", () => {
  it("appends the section in one request: heading, summary, each document folded, and an unticked box bound to the revision", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web", body: [para("The person's own words.")] });

    await board.requestApproval(card, approval());

    expect(notion.sent("PATCH", /\/children$/)).toHaveLength(1);
    expect(notion.outline(card)).toEqual([
      { type: "paragraph", text: "The person's own words.", children: [] },
      { type: "heading_2", text: `Acceptance criteria${BOARD_TEXT.version}3f2a9c1`, children: [] },
      { type: "paragraph", text: "What the finished product must visibly do.", children: [] },
      { type: "paragraph", text: "Two items, four scenarios.", children: [] },
      { type: "toggle", text: "acceptance.yaml", children: ["items:\n  - id: A1", "  - id: A2"] },
      { type: "toggle", text: "out-of-scope.md", children: ["No billing."] },
      { type: "to_do", text: `${BOARD_TEXT.approve}hivemind:approval:product:${REVISION}`, checked: false, children: [] },
    ]);
  });

  it("writes a section once however often it is asked, even by a process that forgot writing it", async () => {
    const { notion, board, fresh } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });

    await board.requestApproval(card, approval());
    const afterFirst = notion.requests.length;
    await board.requestApproval(card, approval());
    expect(notion.requests).toHaveLength(afterFirst);

    await fresh().requestApproval(card, approval());
    expect(notion.sent("PATCH", /\/children$/)).toHaveLength(1);

    await board.requestApproval(card, approval({ revision: LATER_REVISION }));
    expect(notion.sent("PATCH", /\/children$/)).toHaveLength(2);
    expect(notion.outline(card).filter((block) => block.type === "to_do").map((block) => block.text)).toEqual([
      `${BOARD_TEXT.approve}hivemind:approval:product:${REVISION}`,
      `${BOARD_TEXT.approve}hivemind:approval:product:${LATER_REVISION}`,
    ]);
  });

  it("does not write a section again while the page listing still lags the append", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });
    notion.lagAppends = true;

    await board.requestApproval(card, approval());
    await board.requestApproval(card, approval());
    expect(notion.sent("PATCH", /\/children$/)).toHaveLength(1);
  });

  it("cuts a document too large for one request and says so, rather than splitting the section", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });
    // 150,000 characters of Chinese are 450KB on the wire: past the budget,
    // although the same count of ASCII letters is not.
    const document = { name: "architecture.md", content: "\u7532".repeat(150_000) };

    await board.requestApproval(card, approval({ documents: [document] }));

    const [append] = notion.sent("PATCH", /\/children$/);
    expect(new TextEncoder().encode(JSON.stringify(append?.body)).byteLength).toBeLessThanOrEqual(500_000);
    const folded = notion.outline(card).find((block) => block.type === "toggle");
    expect(folded?.children.join("\n\n").endsWith(BOARD_TEXT.truncated)).toBe(true);
    expect(notion.outline(card).at(-1)?.type).toBe("to_do");

    const other = notion.addPage({ title: "Other", repository: "acme/web" });
    await board.requestApproval(other, approval({ documents: [{ name: "architecture.md", content: "x".repeat(150_000) }] }));
    const whole = notion.outline(other).find((block) => block.type === "toggle");
    expect(whole?.children.join("")).toBe("x".repeat(150_000));
  });

  it("folds a document with more paragraphs than one block may hold, keeping every word", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });
    const content = Array.from({ length: 250 }, (_, index) => `Paragraph ${index}.`).join("\n\n");

    await board.requestApproval(card, approval({ documents: [{ name: "notes.md", content }] }));

    const folded = notion.outline(card).find((block) => block.type === "toggle");
    expect(folded?.children.length).toBeLessThanOrEqual(100);
    expect(folded?.children.join("\n\n")).toBe(content);
  });
});

describe("ask", () => {
  it("asks once, as a page comment with numbered options and the question's marker", async () => {
    const { notion, board, fresh } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });
    const question = { id: "q-1", body: "Which database should the console read?", options: ["SQLite", "Postgres"] };

    await board.ask(card, question);
    await board.ask(card, question);
    await fresh().ask(card, question);

    expect(notion.commentTexts(card)).toEqual([[
      "Which database should the console read?",
      "",
      "1. SQLite",
      "2. Postgres",
      "",
      BOARD_TEXT.replyWithOption,
      "hivemind:question:q-1",
    ].join("\n")]);
    expect(notion.sent("POST", /^\/v1\/comments$/)).toHaveLength(1);
  });

  it("tells one question from another whose id merely starts the same", async () => {
    const { notion, board, fresh } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });

    await board.ask(card, { id: "q-10", body: "Tenth?", options: [] });
    await fresh().ask(card, { id: "q-1", body: "First?", options: [] });

    expect(notion.commentTexts(card)).toEqual([
      `Tenth?\n\n${BOARD_TEXT.reply}\nhivemind:question:q-10`,
      `First?\n\n${BOARD_TEXT.reply}\nhivemind:question:q-1`,
    ]);
  });
});

describe("report", () => {
  it("appends a heading carrying the marker and the body as paragraphs, once", async () => {
    const { notion, board, fresh } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });
    const report = { id: "milestone-1", title: "First milestone", body: "The board page works.\n\nNext: the settings page." };

    await board.report(card, report);
    await fresh().report(card, report);

    expect(notion.outline(card)).toEqual([
      { type: "heading_2", text: "First milestone hivemind:report:milestone-1", children: [] },
      { type: "paragraph", text: "The board page works.", children: [] },
      { type: "paragraph", text: "Next: the settings page.", children: [] },
    ]);
  });
});

describe("pollInputs", () => {
  it("returns what people wrote after the cursor, reading two minutes back because comments are stamped to the minute", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });
    const early = notion.addComment(card, PERSON, "An early thought.", "2026-09-24T09:50:00.000Z");
    const before = notion.addComment(card, PERSON, "Written just before the cursor.", "2026-09-24T10:03:00.000Z");
    notion.addComment(card, BOT, "The system's own words.", "2026-09-24T10:04:00.000Z");
    const after = notion.addComment(card, PERSON, "Use SQLite.", "2026-09-24T10:05:00.000Z");

    const first = await board.pollInputs(card, null);
    expect(first.inputs.map((input) => input.sourceId)).toEqual([early, before, after]);
    expect(first.inputs[2]).toEqual({
      kind: "comment",
      sourceId: after,
      body: "Use SQLite.",
      author: "Ryan Xia",
      at: "2026-09-24T10:05:00.000Z",
    });
    expect(first.cursor).toBe("2026-09-24T10:05:00.000Z");

    const again = await board.pollInputs(card, "2026-09-24T10:05:30.000Z");
    expect(again.inputs.map((input) => input.sourceId)).toEqual([before, after]);
    expect(again.cursor).toBe("2026-09-24T10:05:30.000Z");

    const reply = notion.addComment(card, PERSON, "And keep it local.", "2026-09-24T10:06:00.000Z");
    const next = await board.pollInputs(card, again.cursor);
    expect(next.inputs.map((input) => input.sourceId)).toEqual([before, after, reply]);
    expect(next.cursor).toBe("2026-09-24T10:06:00.000Z");
    // A person's name is looked up once, not once per comment.
    expect(notion.sent("GET", /^\/v1\/users\//)).toHaveLength(1);
  });

  it("never reads the system's own question back as an answer", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });
    await board.ask(card, { id: "q-1", body: "Which database?", options: ["SQLite", "Postgres"] });
    await expect(board.pollInputs(card, null)).resolves.toEqual({ inputs: [], cursor: "2026-09-24T10:00:00.000Z" });
  });

  it("keeps the id of a person the workspace will not name, and does not ask again", async () => {
    const { notion, board } = setup();
    notion.forbidUsers = true;
    const card = notion.addPage({ title: "Console", repository: "acme/web" });
    notion.addComment(card, PERSON, "First.", "2026-09-24T10:01:00.000Z");
    notion.addComment(card, PERSON, "Second.", "2026-09-24T10:02:00.000Z");

    const { inputs } = await board.pollInputs(card, null);
    expect(inputs.map((input) => input.author)).toEqual([PERSON, PERSON]);
    await board.pollInputs(card, null);
    expect(notion.sent("GET", /^\/v1\/users\//)).toHaveLength(1);
  });

  it("reads a ticked approval box as an approval of exactly that revision", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web", body: [checkbox("A box of the person's own", false)] });
    await board.requestApproval(card, approval());
    await expect(board.pollInputs(card, null)).resolves.toEqual({ inputs: [], cursor: null });

    const blocks = notion.blockIds(card);
    const ownBox = blocks[0]!;
    const firstBox = blocks.at(-1)!;
    notion.tick(ownBox);
    notion.now = Date.parse("2026-09-24T10:07:20.000Z");
    notion.tick(firstBox);
    await board.requestApproval(card, approval({ gate: "architecture", revision: LATER_REVISION, title: "Architecture" }));

    const { inputs } = await board.pollInputs(card, null);
    expect(inputs).toEqual([{
      kind: "approval",
      sourceId: `${firstBox}:${REVISION}`,
      gate: "product",
      revision: REVISION,
      author: "Ryan Xia",
      at: "2026-09-24T10:07:00.000Z",
    }]);
  });
});

describe("setStatus", () => {
  it("writes only the system-owned status, in the board's words", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });

    for (const status of ["queued", "working", "needs_input", "stopped", "done"] as const) {
      await board.setStatus(card, status, "ignored without a note property");
      expect(notion.property(card, NAMES.status)).toMatchObject({ select: { name: BOARD_TEXT.status[status] } });
    }
    for (const request of notion.sent("PATCH", /^\/v1\/pages\//)) {
      expect(Object.keys((request.body as { properties: object }).properties)).toEqual([NAMES.status]);
    }
    expect(notion.property(card, "Priority")).toMatchObject({ select: { name: "P1" } });
    expect(notion.property(card, NAMES.repository)).toMatchObject({ select: { name: "acme/web" } });
  });

  it("writes the note beside it when the board has one, and clears it with none", async () => {
    const { notion, board } = setup({ text: { ...BOARD_TEXT, properties: { ...NAMES, note: "Note" }, status: { ...BOARD_TEXT.status, needs_input: "Waiting on you" } } });
    const card = notion.addPage({ title: "Console", repository: "acme/web" });

    await board.setStatus(card, "needs_input", "Approve the acceptance criteria.");
    expect(notion.property(card, NAMES.status)).toMatchObject({ select: { name: "Waiting on you" } });
    expect(notion.property(card, "Note")).toMatchObject({ rich_text: [{ plain_text: "Approve the acceptance criteria." }] });

    await board.setStatus(card, "working", null);
    expect(notion.property(card, "Note")).toMatchObject({ rich_text: [] });
  });

  it("surfaces a page a person deleted as a 404 on every touchpoint", async () => {
    const { notion, board } = setup();
    const card = notion.addPage({ title: "Console", repository: "acme/web" });
    notion.trash(card);

    await expect(board.setStatus(card, "working", null)).rejects.toMatchObject({ status: 404, code: "object_not_found" });
    await expect(board.requestApproval(card, approval())).rejects.toMatchObject({ status: 404 });
    await expect(board.pollInputs(card, null)).rejects.toMatchObject({ status: 404 });
  });
});
