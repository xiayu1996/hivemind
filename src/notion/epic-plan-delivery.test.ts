import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../persistence/migrate.js";
import { NotionEpicPlanDelivery } from "./epic-plan-delivery.js";
import type { NotionGateway } from "./gateway.js";
import type { NotionOutboxRecord } from "./outbox.js";

const PLAN = {
  epicId: "M2",
  businessGoal: "Customers see one review request per initiative.",
  stories: [{ id: "S-M2-01", title: "Split the initiative" }, { id: "S-M2-02", title: "Approve the split" }],
};

function record(operation: string, payload: unknown, overrides: Partial<NotionOutboxRecord> = {}): NotionOutboxRecord {
  return {
    id: 1,
    cardId: "M2",
    operation,
    target: "epic-page",
    payload,
    payloadHash: "a".repeat(64),
    priority: 1,
    ...overrides,
  } as NotionOutboxRecord;
}

describe("NotionEpicPlanDelivery", () => {
  let client: ReturnType<typeof createClient>;
  let requests: Array<{ method: string; path: string; body?: unknown }>;
  let children: unknown[];

  function gateway(): NotionGateway {
    return {
      request: vi.fn(async (request: { method: string; path: string; body?: unknown }) => {
        requests.push(request);
        if (request.method === "GET" && request.path.includes("/children")) {
          return { status: 200, data: { results: children, has_more: false } };
        }
        if (request.path.endsWith("/query")) {
          return { status: 200, data: { results: children, has_more: false } };
        }
        if (request.method === "PATCH" && request.path.includes("/children")) {
          const appended = (request.body as { children: unknown[] }).children;
          return { status: 200, data: { results: appended.map((_, index) => ({ id: `new-${index}` })) } };
        }
        return { status: 200, data: { id: "created-page" } };
      }),
    } as unknown as NotionGateway;
  }

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await migrate(client);
    requests = [];
    children = [];
  });

  afterEach(() => client.close());

  describe("present_epic_plan", () => {
    beforeEach(async () => {
      await client.execute(
        "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2','epic-page','Delivery','PLAN_APPROVAL',1,1)",
      );
    });

    it("puts the decomposition on the Epic page for a human to read", async () => {
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await delivery.send(record("present_epic_plan", PLAN));

      const append = requests.find((request) => request.method === "PATCH");
      const text = JSON.stringify(append?.body);
      expect(append?.path).toContain("epic-page");
      // The goal is the projection's to render, under its own heading, next
      // to the scenarios this batch carries.
      expect(text).not.toContain("Customers see one review request per initiative.");
      expect(text).toContain("S-M2-01");
      // The name comes first and the id follows it as a handle.
      expect(text).toContain('"content":"Split the initiative"');
      expect(text).toContain("S-M2-02");
      // The replay key is kept off the page a person reads.
      expect(text).not.toContain("hivemind-plan:");
      const applied = await client.execute("SELECT payload_hash FROM epic_notion_sections WHERE epic_id = 'M2' AND section = 'plan'");
      expect(applied.rows[0]?.payload_hash).toBe("a".repeat(64));
    });

    it("recognises the plan it delivered and does not post it twice", async () => {
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");
      await delivery.send(record("present_epic_plan", PLAN));
      await expect(delivery.isApplied(record("present_epic_plan", PLAN))).resolves.toBe(true);
    });

    it("carries the split recommendation when the decomposition made one", async () => {
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");
      await delivery.send(record("present_epic_plan", { ...PLAN, recommendation: "考虑拆分 Epic" }));
      expect(JSON.stringify(requests.at(-1)?.body)).toContain("考虑拆分 Epic");
    });

    it("recognises a plan an older projection marked on the page itself", async () => {
      children = [{
        id: "block-1",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: `hivemind-plan:${"a".repeat(64)}` }] },
      }];
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await expect(delivery.isApplied(record("present_epic_plan", PLAN))).resolves.toBe(true);
    });

    it("posts a revised plan even though an older one is on the page", async () => {
      children = [{
        id: "block-1",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: `hivemind-plan:${"b".repeat(64)}` }] },
      }];
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await expect(delivery.isApplied(record("present_epic_plan", PLAN))).resolves.toBe(false);
    });
  });

  describe("create_story_page", () => {
    beforeEach(async () => {
      await client.batch([
        "INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2','epic-page','Delivery','PLAN_APPROVAL',1,1)",
        `INSERT INTO stories (id, epic_id, notion_page_id, title, requirement, state, repo, target_branch, priority, created_at, updated_at)
           VALUES ('S-M2-01','M2','placeholder-id','Split the initiative','A large initiative becomes reviewable stories.','QUEUED','owner/repo','main',1,1,1)`,
      ], "write");
    });

    it("creates the Story page and replaces the placeholder id with the real one", async () => {
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await delivery.send(record("create_story_page", { epicId: "M2", storyId: "S-M2-01" }, { cardId: "S-M2-01", target: "M2" }));

      const create = requests.find((request) => request.path === "/v1/pages");
      const body = JSON.stringify(create?.body);
      expect(body).toContain("stories-ds");
      expect(body).toContain("S-M2-01");
      expect(body).toContain("Split the initiative");
      expect(body).toContain("epic-page");
      const stored = (await client.execute("SELECT notion_page_id FROM stories WHERE id = 'S-M2-01'")).rows[0];
      expect(stored?.notion_page_id).toBe("created-page");
    });

    it("adopts a page that already carries the task id instead of creating a second one", async () => {
      children = [{ id: "existing-page", properties: { "任务 ID": { rich_text: [{ plain_text: "S-M2-01" }] } } }];
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");

      await expect(delivery.isApplied(record("create_story_page", { epicId: "M2", storyId: "S-M2-01" }, { cardId: "S-M2-01" })))
        .resolves.toBe(true);
      const stored = (await client.execute("SELECT notion_page_id FROM stories WHERE id = 'S-M2-01'")).rows[0];
      expect(stored?.notion_page_id).toBe("existing-page");
      expect(requests.some((request) => request.path === "/v1/pages")).toBe(false);
    });
  });

  it("refuses an operation it does not implement rather than reporting success", async () => {
    const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds");
    await expect(delivery.send(record("sync_story_page", {}))).rejects.toThrow(/unsupported/);
  });

  describe("sync_epic_status", () => {
    async function epic(shadow: string | null = null, humanWinsUntil = 0): Promise<void> {
      await client.execute({
        sql: `INSERT INTO epics (id, notion_page_id, title, state, notion_status_shadow, human_wins_until, created_at, updated_at)
              VALUES ('M2', 'epic-page', 'M2 Plan', 'PLAN_APPROVAL', ?, ?, 1, 1)`,
        args: [shadow, humanWinsUntil],
      });
    }
    function boardShowing(status: string | null): NotionGateway {
      return {
        request: vi.fn(async (request: { method: string; path: string; body?: unknown }) => {
          requests.push(request);
          return { status: 200, data: { properties: { "Epic 状态": { select: status ? { name: status } : null } } } };
        }),
      } as unknown as NotionGateway;
    }
    const payload = { epicId: "M2", status: "拆解待确认", at: 5 };

    it("moves the card on the board and remembers that the move was its own", async () => {
      await epic();
      const delivery = new NotionEpicPlanDelivery(boardShowing("待拆解"), client, "stories-ds", () => 10);

      expect(await delivery.isApplied(record("sync_epic_status", payload))).toBe(false);
      await delivery.send(record("sync_epic_status", payload));

      const patch = requests.find((request) => request.method === "PATCH");
      expect(patch?.path).toBe("/v1/pages/epic-page");
      expect(JSON.stringify(patch?.body)).toContain("拆解待确认");
      const row = (await client.execute("SELECT notion_status_shadow FROM epics WHERE id = 'M2'")).rows[0];
      expect(row?.notion_status_shadow).toBe("拆解待确认");
    });

    it("writes nothing when the board already shows the status", async () => {
      await epic();
      const delivery = new NotionEpicPlanDelivery(boardShowing("拆解待确认"), client, "stories-ds", () => 10);
      expect(await delivery.isApplied(record("sync_epic_status", payload))).toBe(true);
      expect(requests.filter((request) => request.method === "PATCH")).toEqual([]);
    });

    it("does not overwrite a column a person just changed", async () => {
      await epic("进行中", 1_000);
      const delivery = new NotionEpicPlanDelivery(boardShowing("进行中"), client, "stories-ds", () => 10);
      expect(await delivery.isApplied(record("sync_epic_status", payload))).toBe(true);
      expect(requests).toEqual([]);
    });
  });

  describe("comment_epic_page", () => {
    const payload = { epicId: "M2", body: "[拆解阻塞问题] 面向哪个客户群？" };
    async function blockedEpic(): Promise<void> {
      await client.execute("INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2', 'epic-page', 'M2', 'BLOCKED', 1, 1)");
    }
    function pageWithComments(bodies: string[]): NotionGateway {
      return {
        request: vi.fn(async (request: { method: string; path: string; body?: unknown }) => {
          requests.push(request);
          if (request.method === "GET") {
            return { status: 200, data: { results: bodies.map((body) => ({ rich_text: [{ plain_text: body }] })), has_more: false } };
          }
          return { status: 200, data: { id: "comment-1" } };
        }),
      } as unknown as NotionGateway;
    }

    it("asks the question on the Epic page exactly once", async () => {
      await blockedEpic();
      const delivery = new NotionEpicPlanDelivery(pageWithComments([]), client, "stories-ds");
      expect(await delivery.isApplied(record("comment_epic_page", payload))).toBe(false);
      await delivery.send(record("comment_epic_page", payload));
      const post = requests.find((request) => request.method === "POST");
      expect(post?.path).toBe("/v1/comments");
      expect(JSON.stringify(post?.body)).toContain("面向哪个客户群？");

      const again = new NotionEpicPlanDelivery(pageWithComments([payload.body]), client, "stories-ds");
      expect(await again.isApplied(record("comment_epic_page", payload))).toBe(true);
    });
  });

  describe("sync_epic_page", () => {
    const payload = {
      epicId: "M2",
      state: "EPIC_ACCEPT",
      status: "\u9a8c\u6536\u4e2d",
      mrUrl: "https://example.test/pull/26",
      targetBranch: "main",
      integrationBranch: "epic/M2",
      businessGoal: "\u8ba9\u4eba\u4e00\u6b21\u9a8c\u6536\u4e00\u6279\u4ea4\u4ed8",
      prdScenarios: [{ id: "s01", text: "\u7ba1\u7406\u5458\u6253\u5f00\u89c4\u5219\u9875\uff0c\u4fdd\u5b58\u4e00\u6761\u89c4\u5219\uff0c\u5217\u8868\u91cc\u51fa\u73b0\u5b83" }],
      stories: [
        { id: "S-M2-01", title: "Split", pageId: "3dd20688-7a32-815a-a78b-d1e934a4d958", dependsOn: [] },
        { id: "S-M2-02", title: "Approve", pageId: null, dependsOn: ["S-M2-01"] },
      ],
      acceptance: [],
    };

    it("writes what the batch carries, links the Stories it planned, and takes the progress section away", async () => {
      await client.execute("INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2', 'epic-page', 'M2', 'EPIC_ACCEPT', 1, 1)");
      children = [
        { id: "b-body", type: "paragraph", paragraph: { rich_text: [{ plain_text: "\u8fd9\u4e00\u6279\u8981\u505a\u4ec0\u4e48" }] } },
        { id: "b-plan", type: "heading_2", heading_2: { rich_text: [{ plain_text: "\u62c6\u89e3\u65b9\u6848" }] } },
        { id: "b-plan-1", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Split S-M2-01" }] } },
        { id: "b-progress", type: "heading_2", heading_2: { rich_text: [{ plain_text: "\u8fdb\u5c55" }] } },
        { id: "b-old-1", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "S-M2-01 Split \u2014 \u5f00\u53d1\u4e2d" }] } },
        { id: "b-old-marker", type: "paragraph", paragraph: { rich_text: [{ plain_text: "hivemind-progress:old" }] } },
      ];
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds", () => 10);

      expect(await delivery.isApplied(record("sync_epic_page", payload, { payloadHash: "new" }))).toBe(false);
      await delivery.send(record("sync_epic_page", payload, { payloadHash: "new" }));

      const properties = requests.find((request) => request.method === "PATCH" && request.path === "/v1/pages/epic-page");
      expect(JSON.stringify(properties?.body)).toContain("\u9a8c\u6536\u4e2d");
      expect(JSON.stringify(properties?.body)).toContain("https://example.test/pull/26");
      // The progress section and the marker line go; the plan a person
      // approved is never touched.
      expect(requests.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual([
        "/v1/blocks/b-progress", "/v1/blocks/b-old-1", "/v1/blocks/b-old-marker",
      ]);
      const appended = requests
        .filter((request) => request.method === "PATCH" && request.path.endsWith("/children"))
        .map((request) => JSON.stringify(request.body));
      const written = appended.join("\n");
      expect(written).toContain("\u76ee\u6807");
      expect(written).toContain("\u8ba9\u4eba\u4e00\u6b21\u9a8c\u6536\u4e00\u6279\u4ea4\u4ed8");
      expect(written).toContain("\u5217\u8868\u91cc\u51fa\u73b0\u5b83");
      expect(written).toContain("\u5728\u300c\u9a8c\u6536\u300d\u533a\u9010\u6761\u6253\u52fe");
      expect(written).toContain("epic/M2");
      // Nothing about where a Story is: that is the board's job.
      expect(written).not.toContain("\u5f00\u53d1\u4e2d");
      expect(written).not.toContain("hivemind-progress:");
      // The callout goes first and the goal right after it, above the plan a
      // person approved; the rest goes below the plan.
      expect(appended[0]).toContain('"after":"b-body"');
      expect(appended[0]).toContain('"type":"callout"');
      expect(appended[1]).toContain('"after":"new-0"');
      // A planned Story that now has a page reads as a link to it.
      const mention = requests.find((request) => request.path === "/v1/blocks/b-plan-1");
      expect(JSON.stringify(mention?.body)).toContain("3dd20688-7a32-815a-a78b-d1e934a4d958");
      const applied = await client.execute("SELECT payload_hash FROM epic_notion_sections WHERE epic_id = 'M2' AND section = 'page'");
      expect(applied.rows[0]?.payload_hash).toBe("new");
      const row = (await client.execute("SELECT notion_status_shadow FROM epics WHERE id = 'M2'")).rows[0];
      expect(row?.notion_status_shadow).toBe("\u9a8c\u6536\u4e2d");
    });

    it("recognises a page that already shows this", async () => {
      await client.execute("INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at) VALUES ('M2', 'epic-page', 'M2', 'EPIC_ACCEPT', 1, 1)");
      children = [{ id: "m", type: "paragraph", paragraph: { rich_text: [{ plain_text: "hivemind-progress:same" }] } }];
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds", () => 10);
      expect(await delivery.isApplied(record("sync_epic_page", payload, { payloadHash: "same" }))).toBe(true);
    });

    it("writes the acceptance boxes once and afterwards only rewrites what they say", async () => {
      await client.batch([
        `INSERT INTO epics (id, notion_page_id, title, state, created_at, updated_at)
         VALUES ('M2', 'epic-page', 'M2', 'EPIC_ACCEPT', 1, 1)`,
        `INSERT INTO epic_acceptance_items (epic_id, prd_scenario_id, text, status, created_at)
         VALUES ('M2', 's01', '\u4fdd\u5b58\u4e00\u6761\u89c4\u5219\uff0c\u5217\u8868\u91cc\u51fa\u73b0\u5b83', 'open', 1)`,
      ], "write");
      const judged = { ...payload, acceptance: [
        { prdScenarioId: "s01", text: "\u4fdd\u5b58\u4e00\u6761\u89c4\u5219\uff0c\u5217\u8868\u91cc\u51fa\u73b0\u5b83", status: "open", note: null },
      ] };
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds", () => 10);
      await delivery.send(record("sync_epic_page", judged, { payloadHash: "new" }));

      const boxes = requests
        .filter((request) => request.method === "PATCH" && request.path.endsWith("/children"))
        .map((request) => JSON.stringify(request.body))
        .filter((body) => body.includes("to_do"));
      expect(boxes).toHaveLength(1);
      // The tick lives on the block, so the block id is what the database
      // keeps: without it a reprojection would ask the same question twice.
      const bound = await client.execute("SELECT notion_block_id FROM epic_acceptance_items WHERE epic_id = 'M2'");
      expect(String(bound.rows[0]?.notion_block_id)).toMatch(/^new-/);

      // Second pass: the person has said what is missing, and the box that
      // carries their comment is rewritten rather than replaced.
      const blockId = String(bound.rows[0]?.notion_block_id);
      children = [
        { id: "b-accept", type: "heading_2", heading_2: { rich_text: [{ plain_text: "\u9a8c\u6536" }] } },
        { id: blockId, type: "to_do", to_do: { rich_text: [{ plain_text: "\u4fdd\u5b58\u4e00\u6761\u89c4\u5219\uff0c\u5217\u8868\u91cc\u51fa\u73b0\u5b83" }] } },
      ];
      requests = [];
      await delivery.send(record("sync_epic_page", {
        ...judged,
        acceptance: [{ ...judged.acceptance[0]!, status: "gap", note: "\u4fdd\u5b58\u540e\u6ca1\u5237\u65b0" }],
      }, { payloadHash: "newer" }));
      expect(requests.filter((request) => request.method === "DELETE").map((request) => request.path))
        .not.toContain(`/v1/blocks/${blockId}`);
      const rewrite = requests.find((request) => request.path === `/v1/blocks/${blockId}`);
      expect(JSON.stringify(rewrite?.body)).toContain("\u4fdd\u5b58\u540e\u6ca1\u5237\u65b0");
      // The answer is the person's: a projection never ticks or unticks.
      expect(JSON.stringify(rewrite?.body)).not.toContain("checked");
    });

    it("leaves the column alone while a person's drag still stands, but still updates the page", async () => {
      await client.execute("INSERT INTO epics (id, notion_page_id, title, state, human_wins_until, created_at, updated_at) VALUES ('M2', 'epic-page', 'M2', 'EPIC_ACCEPT', 1000, 1, 1)");
      const delivery = new NotionEpicPlanDelivery(gateway(), client, "stories-ds", () => 10);
      await delivery.send(record("sync_epic_page", payload, { payloadHash: "new" }));
      const properties = requests.find((request) => request.method === "PATCH" && request.path === "/v1/pages/epic-page");
      expect(JSON.stringify(properties?.body)).not.toContain("\u9a8c\u6536\u4e2d");
      expect(JSON.stringify(properties?.body)).toContain("https://example.test/pull/26");
    });
  });
});
