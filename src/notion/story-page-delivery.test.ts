import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { StoryExecutionStore } from "../orchestrator/story-execution-store.js";
import { parseDoD } from "../pipeline/dod.js";
import { migrate } from "../persistence/migrate.js";
import { NotionGateway, type NotionRequest, type NotionTransport } from "./gateway.js";
import { NotionOutbox } from "./outbox.js";
import { NotionStoryPageDelivery } from "./story-page-delivery.js";
import { NotionStoryDelivery, NotionStoryPropertyDelivery } from "./story-property-delivery.js";
import { NotionStoryProjection } from "./story-projection.js";

interface FakeBlock {
  id: string;
  type: string;
  archived?: boolean;
  [key: string]: unknown;
}

/** The round toggles, told apart from the one the technical section folds
 * itself behind by the line a round writes. */
function roundToggles(blocks: FakeBlock[]): FakeBlock[] {
  return blocks.filter((item) => {
    const payload = item[item.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
    const written = payload?.rich_text?.map((run) => run.plain_text ?? "").join("") ?? "";
    return item.type === "toggle" && /^\u7b2c \d+ \u8f6e/.test(written);
  });
}

function plainText(items: unknown): unknown[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const source = item as { text?: { content?: string } };
    return { ...source, plain_text: source.text?.content ?? "" };
  });
}

class FakeNotion {
  readonly children = new Map<string, FakeBlock[]>();
  readonly properties: Record<string, unknown> = {};
  /** When set, a listing right after an append still shows the page as it was
   * before that append, the way Notion's children endpoint can lag. */
  lagAppends = false;
  private stale = new Map<string, FakeBlock[]>();
  private nextId = 1;

  constructor(pageId: string) {
    this.children.set(pageId, [
      this.create({ object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "\u9700\u6c42\u63cf\u8ff0" } }] } }),
      this.create({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Requirement" } }] } }),
    ]);
  }

  readonly transport: NotionTransport = async (request) => {
    const path = new URL(request.path, "https://notion.invalid").pathname;
    const childrenMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (request.method === "GET" && childrenMatch) {
      return { status: 200, data: this.list(decodeURIComponent(childrenMatch[1]!)) };
    }
    if (request.method === "PATCH" && childrenMatch) {
      return { status: 200, data: this.append(decodeURIComponent(childrenMatch[1]!), request) };
    }
    const blockMatch = /^\/v1\/blocks\/([^/]+)$/.exec(path);
    if (request.method === "GET" && blockMatch) {
      const id = decodeURIComponent(blockMatch[1]!);
      const block = [...this.children.values()].flat().find((item) => item.id === id);
      return block ? { status: 200, data: block } : { status: 404, data: { message: "Could not find block" } };
    }
    if (request.method === "PATCH" && blockMatch) {
      return { status: 200, data: this.patch(decodeURIComponent(blockMatch[1]!), request.body) };
    }
    if (request.method === "POST" && path === "/v1/pages") {
      const body = request.body as { parent: { page_id: string }; properties: { title: { title: Array<{ text: { content: string } }> } } };
      const created = this.create({ object: "block", type: "child_page", child_page: { title: body.properties.title.title[0]!.text.content } });
      const parent = this.children.get(body.parent.page_id);
      if (!parent) throw new Error(`unknown fake parent: ${body.parent.page_id}`);
      parent.push(created);
      return { status: 200, data: { object: "page", id: created.id } };
    }
    const pageMatch = /^\/v1\/pages\/([^/]+)$/.exec(path);
    if (request.method === "GET" && pageMatch) {
      return { status: 200, data: { object: "page", id: decodeURIComponent(pageMatch[1]!), properties: this.properties } };
    }
    if (request.method === "PATCH" && pageMatch) {
      const body = request.body as { properties: Record<string, unknown> };
      for (const [name, property] of Object.entries(body.properties)) {
        const source = property as { rich_text?: unknown[] };
        this.properties[name] = source.rich_text ? { ...source, rich_text: plainText(source.rich_text) } : property;
      }
      return { status: 200, data: { object: "page", id: decodeURIComponent(pageMatch[1]!), properties: this.properties } };
    }
    return { status: 404, data: {} };
  };

  /** A heading an older build wrote, under the name it used then. */
  addHeading(parentId: string, title: string): string {
    const created = this.create({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: title } }] },
    });
    this.children.get(parentId)!.push(created);
    return created.id;
  }

  text(blockId: string): string {
    const block = [...this.children.values()].flat().find((item) => item.id === blockId);
    if (!block) throw new Error(`unknown fake block: ${blockId}`);
    const payload = block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
    return payload?.rich_text?.map((run) => run.plain_text ?? "").join("") ?? "";
  }

  /** Drops a block the way a person deleting it in the app does. */
  remove(blockId: string): void {
    for (const [parent, blocks] of this.children) {
      const index = blocks.findIndex((item) => item.id === blockId);
      if (index >= 0) this.children.set(parent, blocks.toSpliced(index, 1));
    }
  }

  visible(parentId: string): FakeBlock[] {
    return (this.children.get(parentId) ?? []).filter((item) => !item.archived);
  }

  private create(input: Record<string, unknown>): FakeBlock {
    const type = String(input.type);
    const payload = input[type] as Record<string, unknown>;
    const created: FakeBlock = {
      ...input,
      id: `block-${this.nextId++}`,
      [type]: payload?.rich_text ? { ...payload, rich_text: plainText(payload.rich_text) } : payload,
    } as FakeBlock;
    // Every block can hold children in Notion, and this page now puts the
    // scenario detail, the table and the folds underneath blocks of its own.
    this.children.set(created.id, []);
    return created;
  }

  private list(parentId: string) {
    const stale = this.stale.get(parentId);
    if (stale) {
      this.stale.delete(parentId);
      return { object: "list", results: stale.filter((item) => !item.archived), has_more: false, next_cursor: null };
    }
    return { object: "list", results: this.visible(parentId), has_more: false, next_cursor: null };
  }

  private append(parentId: string, request: NotionRequest) {
    const body = request.body as { children: Record<string, unknown>[]; after?: string };
    const target = this.children.get(parentId);
    if (!target) throw new Error(`unknown fake parent: ${parentId}`);
    if (this.lagAppends) this.stale.set(parentId, [...target]);
    const created = body.children.map((item) => this.create(item));
    const index = body.after ? target.findIndex((item) => item.id === body.after) + 1 : target.length;
    target.splice(index, 0, ...created);
    return { object: "list", results: created, has_more: false, next_cursor: null };
  }

  private patch(blockId: string, body: unknown): FakeBlock {
    const block = [...this.children.values()].flat().find((item) => item.id === blockId);
    if (!block) throw new Error(`unknown fake block: ${blockId}`);
    const value = body as Record<string, unknown>;
    if (value.archived === true) block.archived = true;
    const payload = value[block.type] as { rich_text?: unknown[] } | undefined;
    if (payload?.rich_text) block[block.type] = { ...(block[block.type] as object), rich_text: plainText(payload.rich_text) };
    return block;
  }
}

const DOD = `story_id: S-EPIC1-01
design_summary: Design.
scenarios:
  - id: S-EPIC1-01-a
    given: A state
    when: projected
    then: it is visible
    layers: [integration]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: The page is complete.
    scenarios: [S-EPIC1-01-a]
out_of_scope: []
relies_on: []
predicted_footprint: [src]
depends_on: []
`;

describe("NotionStoryPageDelivery", () => {
  it("keeps Spec anchors stable, appends rounds, and archives only beyond eight", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({
      id: "S-EPIC1-01",
      notionPageId: "page-1",
      title: "Story",
      requirement: "Requirement",
    });
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(DOD));

    const fake = new FakeNotion("page-1");
    const gateway = new NotionGateway({ transport: fake.transport, ratePerSecond: 1_000_000, mergeWindowMs: 0 });
    const delivery = new NotionStoryDelivery(
      new NotionStoryPageDelivery(client, gateway, () => 20),
      new NotionStoryPropertyDelivery(gateway, client, () => 20),
    );
    const projection = new NotionStoryProjection(client, () => 20);
    const outbox = new NotionOutbox(client, () => 20);
    let specBlockId: string | undefined;

    for (let round = 1; round <= 9; round++) {
      const accepted = round % 3 === 0;
      await client.batch([
        {
          sql: `INSERT INTO verify_records
                  (card_id, round, code_session_id, verify_session_id, verdict,
                   failed_scenarios, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: ["S-EPIC1-01", round, `code-${round}`, `verify-${round}`,
            accepted ? "accepted" : "rejected", accepted ? "[]" : '["S-EPIC1-01-a"]', 20],
        },
        {
          sql: "UPDATE stories SET inner_loop_rounds = ? WHERE id = ?",
          args: [round, "S-EPIC1-01"],
        },
        {
          sql: "UPDATE story_specs SET status = ? WHERE story_id = ?",
          args: [accepted ? "passed" : "failed", "S-EPIC1-01"],
        },
      ], "write");
      await projection.enqueue("S-EPIC1-01");
      await expect(outbox.replay(delivery)).resolves.toEqual({ sent: 2, failed: 0, failures: [], dead: [], superseded: [] });
      const mapping = await client.execute("SELECT notion_block_id FROM story_specs WHERE spec_id = 'S-EPIC1-01-a'");
      const current = String(mapping.rows[0]?.notion_block_id);
      specBlockId ??= current;
      expect(current).toBe(specBlockId);
      if (round === 3) expect(roundToggles(fake.visible("page-1"))).toHaveLength(3);
    }

    const page = fake.visible("page-1");
    expect(roundToggles(page)).toHaveLength(8);
    expect(page.filter((item) => item.id === specBlockId)).toHaveLength(1);
    const rounds = await client.execute(
      "SELECT round, toggle_block_id, archived_page_id FROM notion_verification_rounds ORDER BY round",
    );
    expect(rounds.rows.map((row) => Number(row.round))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(rounds.rows.map((row) => String(row.toggle_block_id))).size).toBe(9);
    expect(String(rounds.rows[0]?.archived_page_id)).toMatch(/^block-/);
    expect(rounds.rows.slice(1).every((row) => row.archived_page_id === null)).toBe(true);
    const sent = await client.execute("SELECT COUNT(*) AS count FROM notion_outbox WHERE state = 'sent'");
    expect(Number(sent.rows[0]?.count)).toBe(18);
    // The fingerprint is central truth; the board shows a person nothing but
    // the words they can act on.
    expect(Object.keys(fake.properties)).not.toContain("\u540c\u6b65\u6307\u7eb9");
    const stored = await client.execute("SELECT notion_property_fingerprint FROM stories WHERE id = 'S-EPIC1-01'");
    expect(String(stored.rows[0]?.notion_property_fingerprint)).toMatch(/^[a-f0-9]{64}$/);
    client.close();
  });

  it("does not duplicate a round toggle or the stop text when Notion lists the page late", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-EPIC1-01", notionPageId: "page-1", title: "Story", requirement: "Requirement" });
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(DOD));
    await client.execute({
      sql: `INSERT INTO verify_records (card_id, round, code_session_id, verify_session_id, verdict, failed_scenarios, created_at)
            VALUES ('S-EPIC1-01', 1, 'code-1', 'verify-1', 'rejected', '["S-EPIC1-01-a"]', 20)`,
    });
    await client.execute("UPDATE stories SET state = 'NEEDS_INPUT', stop_reason = 'verify_loop_exceeded', resume_state = 'VERIFY' WHERE id = 'S-EPIC1-01'");

    const fake = new FakeNotion("page-1");
    fake.lagAppends = true;
    const gateway = new NotionGateway({ transport: fake.transport, ratePerSecond: 1_000_000, mergeWindowMs: 0 });
    const delivery = new NotionStoryDelivery(
      new NotionStoryPageDelivery(client, gateway, () => 20),
      new NotionStoryPropertyDelivery(gateway, client, () => 20),
    );
    const outbox = new NotionOutbox(client, () => 20);
    await new NotionStoryProjection(client, () => 20).enqueue("S-EPIC1-01");
    await expect(outbox.replay(delivery)).resolves.toEqual({ sent: 2, failed: 0, failures: [], dead: [], superseded: [] });
    // A second projection of the same state must find the page complete.
    await client.execute("UPDATE notion_outbox SET state = 'pending'");
    await expect(outbox.replay(delivery)).resolves.toEqual({ sent: 2, failed: 0, failures: [], dead: [], superseded: [] });

    const page = fake.visible("page-1");
    expect(roundToggles(page)).toHaveLength(1);
    const texts = page.map((item) => {
      const payload = item[item.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
      return payload?.rich_text?.map((run) => run.plain_text ?? "").join("") ?? "";
    });
    expect(texts.filter((text) => text.startsWith("这张卡停下了："))).toHaveLength(1);
    client.close();
  });


  it("renames an older page's headings in place and hangs the detail under the blocks a person already reads", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-EPIC1-01", notionPageId: "page-1", title: "Story", requirement: "Requirement" });
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(`story_id: S-EPIC1-01
design_summary: \u4fdd\u5b58\u540e\u80fd\u770b\u5230\u89c4\u5219\u3002
scenarios:
  - id: S-EPIC1-01-a
    title: \u4fdd\u5b58\u89c4\u5219\u5e76\u56de\u663e
    given: \u7ba1\u7406\u5458\u6253\u5f00\u89c4\u5219\u9875
    when: \u4fdd\u5b58\u4e00\u6761\u89c4\u5219
    then: \u5217\u8868\u91cc\u51fa\u73b0\u8fd9\u6761\u89c4\u5219
    layers: [integration]
baseline:
  type: acceptance_test
acceptance_criteria:
  - text: \u89c4\u5219\u80fd\u4fdd\u5b58\u3002
    scenarios: [S-EPIC1-01-a]
out_of_scope: []
relies_on: []
predicted_footprint: [src]
depends_on: []
`));
    await client.execute({
      sql: `INSERT INTO verify_records (card_id, round, code_session_id, verify_session_id, verdict, failed_scenarios, created_at)
            VALUES ('S-EPIC1-01', 1, 'code-1', 'verify-1', 'accepted', '[]', 20)`,
    });

    await client.execute("UPDATE story_specs SET status = 'passed' WHERE story_id = 'S-EPIC1-01'");

    const fake = new FakeNotion("page-1");
    // The page an older build wrote, under the name it used then.
    const heading = fake.addHeading("page-1", "\u9700\u6c42\u89c4\u683c");
    const gateway = new NotionGateway({ transport: fake.transport, ratePerSecond: 1_000_000, mergeWindowMs: 0 });
    const delivery = new NotionStoryDelivery(
      new NotionStoryPageDelivery(client, gateway, () => 20),
      new NotionStoryPropertyDelivery(gateway, client, () => 20),
    );
    const outbox = new NotionOutbox(client, () => 20);
    await new NotionStoryProjection(client, () => 20).enqueue("S-EPIC1-01");
    await outbox.replay(delivery);

    // The heading keeps its block, so every comment under it keeps its anchor.
    expect(fake.text(heading)).toBe("\u9a8c\u6536\u573a\u666f");
    const specBlockId = String((await client.execute(
      "SELECT notion_block_id FROM story_specs WHERE spec_id = 'S-EPIC1-01-a'",
    )).rows[0]?.notion_block_id);
    expect(fake.text(specBlockId)).toBe("\u2705 \u573a\u666f 1 \u00b7 \u4fdd\u5b58\u89c4\u5219\u5e76\u56de\u663e S-EPIC1-01-a");
    expect(fake.visible(specBlockId).map((item) => fake.text(item.id))).toEqual([
      "\u524d\u63d0\uff1a\u7ba1\u7406\u5458\u6253\u5f00\u89c4\u5219\u9875",
      "\u64cd\u4f5c\uff1a\u4fdd\u5b58\u4e00\u6761\u89c4\u5219",
      "\u7ed3\u679c\uff1a\u5217\u8868\u91cc\u51fa\u73b0\u8fd9\u6761\u89c4\u5219",
      "\u8bc1\u660e\u65b9\u5f0f\uff1a\u96c6\u6210\u6d4b\u8bd5",
    ]);

    // The round reads as a table rather than as a paragraph of every scenario.
    const toggle = String((await client.execute(
      "SELECT toggle_block_id FROM notion_verification_rounds",
    )).rows[0]?.toggle_block_id);
    expect(fake.visible(toggle).map((item) => item.type)).toEqual(["table"]);
    client.close();
  });

  it("asks the page about a round it recorded rather than trusting how recently it wrote it", async () => {
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    const store = new StoryExecutionStore(client, () => 10);
    await store.createStory({ id: "S-EPIC1-01", notionPageId: "page-1", title: "Story", requirement: "Requirement" });
    await store.freezeDefinitionOfDone("S-EPIC1-01", parseDoD(DOD));
    await client.execute({
      sql: `INSERT INTO verify_records (card_id, round, code_session_id, verify_session_id, verdict, failed_scenarios, created_at)
            VALUES ('S-EPIC1-01', 1, 'code-1', 'verify-1', 'rejected', '["S-EPIC1-01-a"]', 20)`,
    });

    const fake = new FakeNotion("page-1");
    const gateway = new NotionGateway({ transport: fake.transport, ratePerSecond: 1_000_000, mergeWindowMs: 0 });
    const page = new NotionStoryPageDelivery(client, gateway, () => 20);
    const delivery = new NotionStoryDelivery(page, new NotionStoryPropertyDelivery(gateway, client, () => 20));
    const outbox = new NotionOutbox(client, () => 20);
    await new NotionStoryProjection(client, () => 20).enqueue("S-EPIC1-01");
    await outbox.replay(delivery);
    const toggle = String((await client.execute("SELECT toggle_block_id FROM notion_verification_rounds")).rows[0]?.toggle_block_id);

    // Hours later, and with the listing lagging so the plan asks for the round
    // again: the toggle is still on the page, so nothing is appended.
    const later = new NotionStoryDelivery(
      new NotionStoryPageDelivery(client, gateway, () => 20 + 60 * 60_000),
      new NotionStoryPropertyDelivery(gateway, client, () => 20 + 60 * 60_000),
    );
    fake.lagAppends = true;
    await client.execute("UPDATE notion_outbox SET state = 'pending', claimed_until = NULL");
    await outbox.replay(later);
    expect(fake.visible("page-1").filter((item) => item.type === "toggle")).toHaveLength(1);

    // A person deleting the toggle is the one case where it must come back.
    await client.execute({ sql: "UPDATE stories SET notion_page_id = 'page-1' WHERE id = 'S-EPIC1-01'" });
    fake.remove(toggle);
    fake.lagAppends = false;
    await client.execute("UPDATE notion_outbox SET state = 'pending', claimed_until = NULL");
    await outbox.replay(later);
    expect(fake.visible("page-1").filter((item) => item.type === "toggle")).toHaveLength(1);
    client.close();
  });
});
