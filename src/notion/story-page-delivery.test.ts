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
    if (request.method === "PATCH" && blockMatch) {
      return { status: 200, data: this.patch(decodeURIComponent(blockMatch[1]!), request.body) };
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
    if (type === "child_page") this.children.set(created.id, []);
    return created;
  }

  private list(parentId: string) {
    return { object: "list", results: this.visible(parentId), has_more: false, next_cursor: null };
  }

  private append(parentId: string, request: NotionRequest) {
    const body = request.body as { children: Record<string, unknown>[]; after?: string };
    const target = this.children.get(parentId);
    if (!target) throw new Error(`unknown fake parent: ${parentId}`);
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
acceptance_criteria: [The page is complete.]
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
      new NotionStoryPropertyDelivery(gateway),
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
      await expect(outbox.replay(delivery)).resolves.toEqual({ sent: 2, failed: 0 });
      const mapping = await client.execute("SELECT notion_block_id FROM story_specs WHERE spec_id = 'S-EPIC1-01-a'");
      const current = String(mapping.rows[0]?.notion_block_id);
      specBlockId ??= current;
      expect(current).toBe(specBlockId);
      if (round === 3) expect(fake.visible("page-1").filter((item) => item.type === "toggle")).toHaveLength(3);
    }

    const page = fake.visible("page-1");
    expect(page.filter((item) => item.type === "toggle")).toHaveLength(8);
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
    expect(Object.keys(fake.properties)).toContain("\u540c\u6b65\u6307\u7eb9");
    client.close();
  });
});
