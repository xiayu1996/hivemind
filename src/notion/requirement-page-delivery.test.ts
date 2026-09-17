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
    const block = {
      ...input,
      id: `block-${this.nextId++}`,
      [type]: payload?.rich_text ? { ...payload, rich_text: plainText(payload.rich_text) } : payload,
    } as FakeBlock;
    // Every block can hold children: the page appends a round's questions
    // under its toggle, and a scenario's three lines under its own item.
    const nested = (payload?.children ?? []) as Record<string, unknown>[];
    this.children.set(block.id, nested.map((child) => this.create(child)));
    return block;
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

  it("builds the sections it owns, with the callout above all of them", async () => {
    await store.openClarifyRound(REQUIREMENT_ID, [
      { question: "\u8c01\u4f1a\u7528\u5b83\uff1f", options: [{ label: "\u503c\u73ed\u7684\u4eba" }] },
    ], "run-ask");
    await projector.publish(REQUIREMENT_ID);
    await replay();

    const contents = fake.contents(PAGE_ID);
    // The request stays at the top, and the callout sits right under it saying
    // what the person has to do next -- both above every heading.
    expect(contents.slice(0, 2)).toEqual([
      "\u6211\u60f3\u968f\u65f6\u77e5\u9053\u73b0\u5728\u5728\u505a\u4ec0\u4e48\u3002",
      "\u56de\u590d\u672c\u9875\u6700\u65b0\u4e00\u6761\u8bc4\u8bba\uff0c\u9009\u5b57\u6bcd\u5373\u53ef\u3002",
    ]);
    expect(contents).toContain("\u6f84\u6e05\u8bb0\u5f55");
    expect(contents).toContain("PRD");
    expect(contents).toContain("\u4ea4\u4ed8\u7ed3\u679c");
    // Nothing on the page repeats what the board column already says.
    expect(contents).not.toContain("\u5143\u4fe1\u606f");
    expect(contents).not.toContain("\u539f\u59cb\u9700\u6c42");

    const fold = fake.visible(PAGE_ID).find((block) => block.type === "toggle")!;
    expect(fake.contents(fold.id)).toEqual([
      "\u95ee 1\u3001\u8c01\u4f1a\u7528\u5b83\uff1f",
      "A. \u503c\u73ed\u7684\u4eba\n\u5176\u4ed6\uff1a\u4ee5\u4e0a\u90fd\u4e0d\u5408\u9002\uff0c\u76f4\u63a5\u5199\u4f60\u7684\u7b54\u6848",
    ]);
    expect(fake.pages.get(PAGE_ID)?.[schema.propertyNames.requirementStatus])
      .toEqual({ select: { name: schema.options.requirementStatus[1] } });

    const sections = (await client.execute("SELECT section FROM requirement_notion_sections ORDER BY section")).rows;
    expect(sections.map((row) => row.section)).toEqual(["callout", "clarify", "delivery", "prd"]);
  });

  it("answers a round in the block it was asked in, and adds the next one after it", async () => {
    await store.openClarifyRound(REQUIREMENT_ID, [
      { question: "\u8c01\u4f1a\u7528\u5b83\uff1f", options: [{ label: "\u503c\u73ed\u7684\u4eba" }] },
    ], "run-ask");
    await projector.publish(REQUIREMENT_ID);
    await replay();
    const first = fake.visible(PAGE_ID).find((block) => block.type === "toggle")!.id;

    await store.recordClarifyAnswers(REQUIREMENT_ID, 1, ["A"], "run-answer");
    await store.openClarifyRound(REQUIREMENT_ID, ["\u591a\u4e45\u5237\u65b0\u4e00\u6b21\uff1f"], "run-ask-2");
    await projector.publish(REQUIREMENT_ID);
    await replay();

    const folds = fake.visible(PAGE_ID).filter((block) => block.type === "toggle");
    // The round a person answered keeps its block, so a comment they left on
    // it is still attached to what they were reading.
    expect(folds.map((block) => block.id)[0]).toBe(first);
    expect(fake.contents(PAGE_ID).filter((line) => line.startsWith("\u7b2c "))).toEqual([
      "\u7b2c 1 \u8f6e \u00b7 1 \u9898 \u00b7 \u5df2\u56de\u7b54",
      "\u7b2c 2 \u8f6e \u00b7 1 \u9898 \u00b7 \u7b49\u4f60\u56de\u7b54",
    ]);
    expect(fake.contents(first)).toContain("\u7b54\uff1aA");
  });

  it("writes a confirmed PRD once and afterwards only says it is confirmed", async () => {
    await store.transition(REQUIREMENT_ID, "CLARIFY", "PRD_CONFIRM", "system", "run-1");
    await store.saveDraftPrd(REQUIREMENT_ID, JSON.stringify({
      businessGoal: "\u503c\u73ed\u7684\u4eba\u968f\u65f6\u770b\u5230\u8fdb\u5ea6",
      nonGoals: ["\u4e0d\u505a\u6743\u9650"],
      scenarios: [{
        id: "s01",
        given: "\u503c\u73ed\u7684\u4eba\u6253\u5f00\u9996\u5c4f",
        when: "\u5237\u65b0\u9875\u9762",
        // oxlint-disable-next-line unicorn/no-thenable -- Given/When/Then is the external PRD contract.
        then: "\u770b\u5230\u5168\u90e8\u5728\u7b49\u4eba\u7684\u5361\u7247",
      }],
      openQuestions: [],
    }), "run-prd");
    await projector.publish(REQUIREMENT_ID);
    await replay();

    const scenario = fake.visible(PAGE_ID).find((block) => block.type === "numbered_list_item")!;
    expect(fake.contents(PAGE_ID)).toContain("\u573a\u666f 1 \u00b7 \u770b\u5230\u5168\u90e8\u5728\u7b49\u4eba\u7684\u5361\u7247 s01");
    expect(fake.contents(scenario.id)).toEqual([
      "\u524d\u63d0\uff1a\u503c\u73ed\u7684\u4eba\u6253\u5f00\u9996\u5c4f",
      "\u64cd\u4f5c\uff1a\u5237\u65b0\u9875\u9762",
      "\u7ed3\u679c\uff1a\u770b\u5230\u5168\u90e8\u5728\u7b49\u4eba\u7684\u5361\u7247",
    ]);

    await store.confirmPrd(REQUIREMENT_ID, 1, "comment-1", "comment", "run-confirm");
    await projector.publish(REQUIREMENT_ID);
    await replay();

    // Confirming adds a banner and nothing else: the words are the ones the
    // person approved, and the scenario they may have commented on stays put.
    expect(fake.visible(PAGE_ID).some((block) => block.id === scenario.id)).toBe(true);
    expect(fake.contents(PAGE_ID)).toContain("\u8fd9\u4efd PRD \u4f60\u5df2\u7ecf\u786e\u8ba4\u8fc7\uff0c\u4e0d\u4f1a\u518d\u88ab\u6539\u5199\u3002");
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
    // The callout is created with the page: a block can only be appended
    // after another one, so this is the only way it sits at the top.
    expect(fake.contents(String(epic?.notion_page_id))).toEqual([
      "现在没有等你处理的事。",
      "值班的人一眼看到谁在等他",
      "打开首屏就能看到全部在等人回答的卡片。",
    ]);
  });
});
