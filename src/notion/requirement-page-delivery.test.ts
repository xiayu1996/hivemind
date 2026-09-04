import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequirementStore } from "../orchestrator/requirement-store.js";
import { migrate } from "../persistence/migrate.js";
import { NotionGateway, type NotionRequest, type NotionTransport } from "./gateway.js";
import { NotionOutbox } from "./outbox.js";
import { NotionRequirementPageDelivery } from "./requirement-page-delivery.js";
import { RequirementPageProjector } from "./requirement-projection.js";
import schema from "./notion-schema.json" with { type: "json" };

const REQUIREMENT_ID = "R-abc123def456";
const PAGE_ID = "requirement-page";

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
  readonly pages = new Map<string, Record<string, unknown>>();
  private nextId = 1;

  constructor(pageId: string) {
    this.children.set(pageId, []);
    this.pages.set(pageId, {});
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
      return { status: 200, data: this.patchBlock(decodeURIComponent(blockMatch[1]!), request.body) };
    }
    const pageMatch = /^\/v1\/pages\/([^/]+)$/.exec(path);
    if (request.method === "GET" && pageMatch) {
      const id = decodeURIComponent(pageMatch[1]!);
      return { status: 200, data: { object: "page", id, properties: this.pages.get(id) ?? {} } };
    }
    if (request.method === "PATCH" && pageMatch) {
      const id = decodeURIComponent(pageMatch[1]!);
      const body = request.body as { properties: Record<string, unknown> };
      this.pages.set(id, { ...this.pages.get(id), ...body.properties });
      return { status: 200, data: { object: "page", id, properties: this.pages.get(id) } };
    }
    if (request.method === "POST" && path === "/v1/pages") {
      const body = request.body as { properties: Record<string, unknown>; children?: Record<string, unknown>[] };
      const id = `created-page-${this.nextId++}`;
      this.pages.set(id, body.properties);
      this.children.set(id, (body.children ?? []).map((child) => this.create(child)));
      return { status: 200, data: { object: "page", id } };
    }
    if (request.method === "POST" && path.endsWith("/query")) {
      return { status: 200, data: { object: "list", results: [], has_more: false, next_cursor: null } };
    }
    return { status: 404, data: {} };
  };

  visible(parentId: string): FakeBlock[] {
    return (this.children.get(parentId) ?? []).filter((item) => !item.archived);
  }

  contents(parentId: string): string[] {
    return this.visible(parentId).map((block) => {
      const payload = block[block.type] as { rich_text?: Array<{ plain_text: string }> } | undefined;
      return (payload?.rich_text ?? []).map((part) => part.plain_text).join("");
    });
  }

  private create(input: Record<string, unknown>): FakeBlock {
    const type = String(input.type);
    const payload = input[type] as Record<string, unknown> | undefined;
    return {
      ...input,
      id: `block-${this.nextId++}`,
      [type]: payload?.rich_text ? { ...payload, rich_text: plainText(payload.rich_text) } : payload,
    } as FakeBlock;
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

  private patchBlock(blockId: string, body: unknown): FakeBlock {
    const block = [...this.children.values()].flat().find((item) => item.id === blockId);
    if (!block) throw new Error(`unknown fake block: ${blockId}`);
    const value = body as Record<string, unknown>;
    if (value.archived === true) block.archived = true;
    const payload = value[block.type] as { rich_text?: unknown[] } | undefined;
    if (payload?.rich_text) {
      block[block.type] = { ...(block[block.type] as object), rich_text: plainText(payload.rich_text) };
    }
    return block;
  }
}

describe("NotionRequirementPageDelivery", () => {
  let client: ReturnType<typeof createClient>;
  let store: RequirementStore;
  let outbox: NotionOutbox;
  let projector: RequirementPageProjector;
  let fake: FakeNotion;
  let delivery: NotionRequirementPageDelivery;

  async function replay(): Promise<void> {
    await outbox.replay(delivery);
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    let time = 1_000;
    store = new RequirementStore(client, () => time++);
    outbox = new NotionOutbox(client, () => time++);
    projector = new RequirementPageProjector(store, outbox);
    fake = new FakeNotion(PAGE_ID);
    const gateway = new NotionGateway({ transport: fake.transport, ratePerSecond: 1_000_000, mergeWindowMs: 0 });
    delivery = new NotionRequirementPageDelivery(client, gateway, "epics-ds", () => 10_000_000);
    await store.createRequirement({
      id: REQUIREMENT_ID,
      notionPageId: PAGE_ID,
      title: "给 hivemind 做一个控制台",
      originalRequest: "我想随时知道现在在做什么。",
    });
  });

  afterEach(() => client.close());

  it("builds the five owned sections and fills them from the record", async () => {
    await store.openClarifyRound(REQUIREMENT_ID, ["谁会用它？"], "run-ask");
    await projector.publish(REQUIREMENT_ID);
    await replay();

    const contents = fake.contents(PAGE_ID);
    expect(contents.slice(0, 2)).toEqual(["元信息", expect.stringContaining("澄清轮次: 1")]);
    expect(contents).toContain("原始需求");
    expect(contents).toContain("我想随时知道现在在做什么。");
    expect(contents).toContain("第 1 轮 问 1: 谁会用它？");
    expect(fake.pages.get(PAGE_ID)?.[schema.propertyNames.requirementStatus])
      .toEqual({ select: { name: schema.options.requirementStatus[1] } });

    const sections = (await client.execute("SELECT section FROM requirement_notion_sections ORDER BY section")).rows;
    expect(sections.map((row) => row.section)).toEqual(["acceptance", "clarify", "metadata", "original", "prd"]);
  });

  it("adds to the clarification log without ever rewriting what is already there", async () => {
    await store.openClarifyRound(REQUIREMENT_ID, ["谁会用它？"], "run-ask");
    await projector.publish(REQUIREMENT_ID);
    await replay();
    const questionBlockId = fake.visible(PAGE_ID)
      .find((_, index) => fake.contents(PAGE_ID)[index] === "第 1 轮 问 1: 谁会用它？")?.id;

    await store.recordClarifyAnswers(REQUIREMENT_ID, 1, ["值班的人"], "run-answer");
    await projector.publish(REQUIREMENT_ID);
    await replay();

    const contents = fake.contents(PAGE_ID);
    expect(contents).toContain("第 1 轮 问 1: 谁会用它？");
    expect(contents).toContain("第 1 轮 答 1: 值班的人");
    expect(fake.visible(PAGE_ID).some((block) => block.id === questionBlockId)).toBe(true);
  });

  it("ties each checklist box to the scenario it stands for", async () => {
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-1");
    await store.seedAcceptanceItems(REQUIREMENT_ID, [
      { itemId: "A01", prdScenarioId: `${REQUIREMENT_ID}-s01`, text: "值班的人一眼看到在等谁" },
    ], "run-seed");
    await projector.publish(REQUIREMENT_ID);
    await replay();

    const items = await store.acceptanceItems(REQUIREMENT_ID);
    expect(items[0]?.notionBlockId).toMatch(/^block-/);
    const box = fake.visible(PAGE_ID).find((block) => block.id === items[0]?.notionBlockId);
    expect(box?.type).toBe("to_do");
    expect((box!.to_do as { checked: boolean }).checked).toBe(false);
  });

  it("creates the Epic page a decomposition asked for and records its real id", async () => {
    await client.execute({
      sql: `INSERT INTO epics (id, notion_page_id, title, state, requirement_id, created_at, updated_at)
            VALUES ('CONSOLE1', 'placeholder-id', 'CONSOLE1 看板首屏', 'INTAKE', ?, 1, 1)`,
      args: [REQUIREMENT_ID],
    });
    await outbox.enqueue({
      cardId: "CONSOLE1",
      priority: 1,
      operation: "create_epic_page",
      target: REQUIREMENT_ID,
      payload: {
        requirementId: REQUIREMENT_ID,
        epicId: "CONSOLE1",
        title: "CONSOLE1 看板首屏",
        body: "值班的人一眼看到谁在等他\n\n打开首屏就能看到全部在等人回答的卡片。",
        scenarioIds: [`${REQUIREMENT_ID}-s01`],
      },
    });

    await replay();

    const epic = (await client.execute("SELECT notion_page_id FROM epics WHERE id = 'CONSOLE1'")).rows[0];
    expect(String(epic?.notion_page_id)).toMatch(/^created-page-/);
    const created = fake.pages.get(String(epic?.notion_page_id));
    expect(created?.[schema.propertyNames.epicStatus]).toEqual({ select: { name: schema.options.epicStatus[0] } });
    expect(created?.[schema.propertyNames.requirementRelation]).toEqual({ relation: [{ id: PAGE_ID }] });
    expect(fake.contents(String(epic?.notion_page_id))).toEqual([
      "值班的人一眼看到谁在等他",
      "打开首屏就能看到全部在等人回答的卡片。",
    ]);
  });
});
